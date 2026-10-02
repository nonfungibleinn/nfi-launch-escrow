// nfi_launch_escrow on a local validator with the real Core Candy Machine and Candy Guard programs, built with
// --features test (a 5 s minimum window). Every payment travels in the same transaction as the guard's mint_v1, the way
// NFI's permit builder sends it. The happy path and every attack the design and the reviews list: a payment with no
// mint, after the mint, with another asset's mint, for another minter, in another group, from another machine or into
// another collection; wrong amounts; paused; late pay; the squat; a machine of another collection; a collection whose
// authority is not the creator, or carrying a permanent delegate, an external adapter, an extra update delegate or an
// update delegate the creator kept; a frozen asset's refund (fails cleanly, works after the thaw); early release; the wrong payout or treasury at release; cancel after the window; wrong-party cancel and
// pause; NFI's key rotation revoking the old key on a live escrow; refunds by strangers, by the current owner after a
// transfer, by the owner of a mint paid by someone else, and the crank on a burned shell; the creator's reveal through
// the program; the collection's authority coming back (by anyone) only when the escrow is final; closing with an
// unclaimed receipt; a receipt closed twice; stray lamports; the config authority handover.
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { generateSigner, keypairIdentity, publicKey as umiPk, some, none, sol, transactionBuilder, type Umi, type KeypairSigner } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, fromWeb3JsInstruction, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { setComputeUnitLimit } from "@metaplex-foundation/mpl-toolbox";
import { addPlugin, approveCollectionPluginAuthority, burn as coreBurn, CheckResult, transfer as coreTransfer, update as coreUpdate, updatePlugin, updateCollectionPlugin, createCollection as createCoreCollection, fetchAsset, fetchCollection, mplCore, updateCollectionV1 } from "@metaplex-foundation/mpl-core";
import { addConfigLines, create as createMachine, findCandyGuardPda, findCandyMachineAuthorityPda, mintV1, mplCandyMachine } from "@metaplex-foundation/mpl-core-candy-machine";
import { expect } from "chai";
import type { NfiLaunchEscrow } from "../target/types/nfi_launch_escrow";

const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const label = (s: string) => { const b = Buffer.alloc(6); b.write(s); return Array.from(b); };
const SOL = (n: number) => new BN(Math.round(n * LAMPORTS_PER_SOL));

describe("nfi_launch_escrow", () => {
  const provider = anchor.AnchorProvider.env();
  (provider.opts as any).commitment = "confirmed";
  (provider.opts as any).preflightCommitment = "confirmed";
  anchor.setProvider(provider);
  const program = anchor.workspace.NfiLaunchEscrow as Program<NfiLaunchEscrow>;
  const conn = provider.connection;
  const authority = (provider.wallet as anchor.Wallet).payer; // the test genesis loads the program with this wallet as upgrade authority
  const creator = Keypair.generate();
  const nfi = Keypair.generate();
  const nfi2 = Keypair.generate();
  const minterA = Keypair.generate();
  const minterB = Keypair.generate();
  const stranger = Keypair.generate();
  const payout = Keypair.generate();
  const treasury = Keypair.generate();
  const airdrop = async (pk: PublicKey, sol = 10) => { const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction(sig, "confirmed"); };
  const bal = (pk: PublicKey) => conn.getBalance(pk, "confirmed");
  const burned = async (pk: PublicKey) => { const a = await conn.getAccountInfo(pk, "confirmed"); return a === null || (a.data.length === 1 && a.data[0] === 0); };
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const pdas = (cm: PublicKey) => {
    const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("launch"), cm.toBuffer()], program.programId);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), escrow.toBuffer()], program.programId);
    return { escrow, vault };
  };
  const receiptPda = (escrow: PublicKey, asset: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("receipt"), escrow.toBuffer(), asset.toBuffer()], program.programId)[0];
  const fails = async (p: Promise<unknown>, needle: string) => { try { await p; } catch (e: any) { const m = String(e.message ?? e) + JSON.stringify(e.logs ?? []) + String(e.cause ?? ""); expect(m, `expected "${needle}" in: ${m.slice(0, 400)}`).to.include(needle); return; } expect.fail(`expected failure: ${needle}`); };

  const umiFor = (kp: Keypair): Umi => createUmi(conn.rpcEndpoint, { commitment: "confirmed" }).use(mplCore()).use(mplCandyMachine()).use(keypairIdentity(fromWeb3JsKeypair(kp)));
  const umiCreator = umiFor(creator);
  const umiA = umiFor(minterA);
  const umiB = umiFor(minterB);

  type Machine = { cm: PublicKey; guard: PublicKey; collection: PublicKey };
  /** A collection and a Core candy machine with two guard groups (wl, pub) and NO payment guards: the escrow is the price. */
  const buildMachine = async (items = 6, plugins: any[] = [], after?: (m: Machine) => Promise<void>, gg: { base?: any; group?: any } = {}): Promise<Machine> => {
    const coll = generateSigner(umiCreator);
    await createCoreCollection(umiCreator, { collection: coll, name: "Launch", uri: "https://launch.nfinn.io/spike/1.json", plugins }).sendAndConfirm(umiCreator);
    const cm = generateSigner(umiCreator);
    const b = await createMachine(umiCreator, {
      candyMachine: cm, collection: coll.publicKey, collectionUpdateAuthority: umiCreator.identity, itemsAvailable: items,
      configLineSettings: some({ prefixName: "Item #", nameLength: 4, prefixUri: "https://launch.nfinn.io/spike/", uriLength: 8, isSequential: false }),
      guards: gg.base ?? {}, groups: [{ label: "wl", guards: gg.group ?? {} }, { label: "pub", guards: gg.group ?? {} }],
    });
    await b.sendAndConfirm(umiCreator);
    await addConfigLines(umiCreator, { candyMachine: cm.publicKey, index: 0, configLines: Array.from({ length: items }, (_, i) => ({ name: String(i + 1), uri: `${(i % 5) + 1}.json` })) }).sendAndConfirm(umiCreator);
    const m: Machine = { cm: toWeb3JsPublicKey(cm.publicKey), guard: toWeb3JsPublicKey(findCandyGuardPda(umiCreator, { base: cm.publicKey })[0]), collection: toWeb3JsPublicKey(coll.publicKey) };
    if (after) await after(m);
    return m;
  };
  const cmAuthorityPda = (m: Machine) => findCandyMachineAuthorityPda(umiCreator, { candyMachine: umiPk(m.cm.toBase58()) })[0];
  /** Gives the collection to somebody else (init itself does the handover to the escrow). */
  const handOver = (m: Machine, to: PublicKey) =>
    updateCollectionV1(umiCreator, { collection: umiPk(m.collection.toBase58()), newUpdateAuthority: umiPk(to.toBase58()), newName: none(), newUri: none() }).sendAndConfirm(umiCreator);
  const collectionAuthority = async (m: Machine) => (await fetchCollection(umiCreator, umiPk(m.collection.toBase58()))).updateAuthority.toString();
  const groups = [{ label: label("wl"), price: SOL(0.5), fee: SOL(0.01) }, { label: label("pub"), price: SOL(1), fee: SOL(0.02) }];
  const initEscrow = async (m: Machine, windowEnd: number, o: { nfiSigner?: Keypair; gs?: typeof groups; payout?: PublicKey; machine?: PublicKey } = {}) => {
    const { escrow, vault } = pdas(o.machine ?? m.cm);
    await program.methods.init({ windowEnd: new BN(windowEnd), groups: o.gs ?? groups })
      .accounts({ config: configPda, escrow, vault, candyMachine: o.machine ?? m.cm, collection: m.collection, payout: o.payout ?? payout.publicKey, creator: creator.publicKey, nfiAuthority: (o.nfiSigner ?? nfi).publicKey, mplCoreProgram: CORE, systemProgram: SystemProgram.programId })
      .signers([creator, o.nfiSigner ?? nfi]).rpc();
    return { escrow, vault };
  };
  type MintOpts = { payGroup?: number; mintGroup?: string; amount?: BN; payAsset?: KeypairSigner; withPay?: boolean; withMint?: boolean; mintMachine?: Machine; mintCollection?: PublicKey; payBefore?: boolean; mintMinter?: Keypair; owner?: PublicKey };
  /** The mint transaction as the permit builder sends it: compute budget, pay, mint_v1. Returns the asset. */
  const mint = async (umi: Umi, minter: Keypair, m: Machine, escrow: PublicKey, vault: PublicKey, o: MintOpts = {}) => {
    const asset = generateSigner(umi);
    const payAsset = o.payAsset ?? asset;
    const g = o.payGroup ?? 1;
    const gg = groups[Math.min(g, groups.length - 1)]!;
    const amount = o.amount ?? new BN(gg.price.toString()).add(new BN(gg.fee.toString()));
    let b = transactionBuilder().add(setComputeUnitLimit(umi, { units: 800_000 }));
    const payIx = async () => {
      const ix = await program.methods.pay(g, amount).accounts({ escrow, vault, receipt: receiptPda(escrow, toWeb3JsPublicKey(payAsset.publicKey)), asset: toWeb3JsPublicKey(payAsset.publicKey), minter: minter.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId }).instruction();
      return { instruction: fromWeb3JsInstruction(ix), signers: [payAsset], bytesCreatedOnChain: 0 };
    };
    if (o.withPay !== false && o.payBefore) b = b.add(await payIx()); // the wrong order, for the test that proves it is refused
    if (o.withMint !== false) {
      const mm = o.mintMachine ?? m;
      const mintMinter = o.mintMinter ? { minter: (umiFor(o.mintMinter)).identity } : {};
      b = b.add(mintV1(umi, { candyMachine: umiPk(mm.cm.toBase58()), candyGuard: umiPk(mm.guard.toBase58()), collection: umiPk((o.mintCollection ?? mm.collection).toBase58()), asset, ...mintMinter, ...(o.owner ? { owner: umiPk(o.owner.toBase58()) } : {}), group: o.mintGroup === "" ? none() : some(o.mintGroup ?? "pub"), mintArgs: {} }));
    }
    if (o.withPay !== false && !o.payBefore) b = b.add(await payIx()); // pay AFTER the mint: the asset must exist by then
    await b.sendAndConfirm(umi);
    return toWeb3JsPublicKey(asset.publicKey);
  };
  const refund = (escrow: PublicKey, vault: PublicKey, asset: PublicKey, minter: PublicKey, signer: Keypair, coll: PublicKey) =>
    program.methods.refund().accounts({ escrow, vault, receipt: receiptPda(escrow, asset), minter, asset, collection: coll, signer: signer.publicKey, mplCoreProgram: CORE, systemProgram: SystemProgram.programId }).signers([signer]).rpc();
  const release = (escrow: PublicKey, vault: PublicKey, signer: Keypair, to = payout.publicKey) =>
    program.methods.release().accounts({ escrow, vault, payout: to, signer: signer.publicKey }).signers([signer]).rpc();
  const releaseFee = (escrow: PublicKey, vault: PublicKey, signer: Keypair, to = treasury.publicKey) =>
    program.methods.releaseFee().accounts({ escrow, vault, treasury: to, signer: signer.publicKey }).signers([signer]).rpc();
  const cancel = (escrow: PublicKey, signer: Keypair) => program.methods.cancel().accounts({ config: configPda, escrow, signer: signer.publicKey }).signers([signer]).rpc();
  const setPaused = (escrow: PublicKey, paused: boolean, signer: Keypair) => program.methods.setPaused(paused).accounts({ config: configPda, escrow, nfiAuthority: signer.publicKey }).signers([signer]).rpc();
  const returnCollection = (escrow: PublicKey, m: Machine, signer = stranger, to = creator.publicKey) =>
    program.methods.returnCollection().accounts({ escrow, collection: m.collection, creator: to, payer: signer.publicKey, mplCoreProgram: CORE, systemProgram: SystemProgram.programId }).signers([signer]).rpc();
  const updateAsset = (escrow: PublicKey, m: Machine, asset: PublicKey, name: string | null, uri: string | null, signer = creator) =>
    program.methods.updateAsset(name, uri).accounts({ escrow, asset, collection: m.collection, creator: signer.publicKey, mplCoreProgram: CORE, systemProgram: SystemProgram.programId }).signers([signer]).rpc();
  const closeEscrow = (escrow: PublicKey, vault: PublicKey, signer = creator) => program.methods.closeEscrow().accounts({ escrow, vault, creator: signer.publicKey }).signers([signer]).rpc();
  const closeReceipt = (escrow: PublicKey, asset: PublicKey, minter: PublicKey) => program.methods.closeReceipt().accounts({ escrow, receipt: receiptPda(escrow, asset), minter, signer: stranger.publicKey }).signers([stranger]).rpc();
  const now = () => Math.floor(Date.now() / 1000);

  before(async () => {
    await Promise.all([airdrop(creator.publicKey, 50), airdrop(nfi.publicKey, 2), airdrop(nfi2.publicKey, 2), airdrop(minterA.publicKey, 20), airdrop(minterB.publicKey, 20), airdrop(stranger.publicKey, 5), airdrop(payout.publicKey, 1), airdrop(treasury.publicKey, 1)]);
    for (let i = 0; i < 40 && (await bal(creator.publicKey)) === 0; i++) await sleep(250);
  });

  describe("config", () => {
    it("only the upgrade authority may create it; the treasury must be a plain wallet; then NFI's key and the treasury are fixed there", async () => {
      const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_LOADER_UPGRADEABLE);
      const initConfig = (auth: Keypair, treas: PublicKey) => program.methods.initConfig(nfi.publicKey).accounts({ config: configPda, authority: auth.publicKey, program: program.programId, programData, treasury: treas, systemProgram: SystemProgram.programId }).signers([auth]).rpc();
      await fails(initConfig(stranger, treasury.publicKey), "NotAuthority");
      await fails(initConfig(authority, programData), "BadWallet"); // a program-owned account can never take the fee
      await initConfig(authority, treasury.publicKey);
      const c = await program.account.config.fetch(configPda);
      expect(c.nfiAuthority.toBase58()).to.equal(nfi.publicKey.toBase58());
      expect(c.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
      await fails(program.methods.updateConfig(nfi.publicKey).accounts({ config: configPda, authority: stranger.publicKey, treasury: treasury.publicKey }).signers([stranger]).rpc(), "NotAuthority");
      await fails(program.methods.updateConfig(nfi.publicKey).accounts({ config: configPda, authority: authority.publicKey, treasury: configPda }).rpc(), "BadWallet");
    });
    it("the authority moves in two steps: only the proposed key may accept, and the old one is then refused", async () => {
      await fails(program.methods.acceptAuthority().accounts({ config: configPda, newAuthority: stranger.publicKey }).signers([stranger]).rpc(), "NotAuthority");
      await program.methods.proposeAuthority(stranger.publicKey).accounts({ config: configPda, authority: authority.publicKey }).rpc();
      await fails(program.methods.acceptAuthority().accounts({ config: configPda, newAuthority: nfi.publicKey }).signers([nfi]).rpc(), "NotAuthority");
      await program.methods.acceptAuthority().accounts({ config: configPda, newAuthority: stranger.publicKey }).signers([stranger]).rpc();
      await fails(program.methods.proposeAuthority(null).accounts({ config: configPda, authority: authority.publicKey }).rpc(), "NotAuthority");
      await program.methods.proposeAuthority(authority.publicKey).accounts({ config: configPda, authority: stranger.publicKey }).signers([stranger]).rpc();
      await program.methods.acceptAuthority().accounts({ config: configPda, newAuthority: authority.publicKey }).rpc();
      const c = await program.account.config.fetch(configPda);
      expect(c.authority.toBase58()).to.equal(authority.publicKey.toBase58());
      expect(c.pendingAuthority).to.equal(null);
    });
  });

  describe("init", () => {
    let m: Machine;
    before(async () => { m = await buildMachine(2); });
    it("refuses bad windows, no groups, nine groups, duplicate labels, an empty label, a label with bytes after its zero", async () => {
      await fails(initEscrow(m, now() + 1), "BadWindow");
      await fails(initEscrow(m, now() + 91 * 86400), "BadWindow");
      await fails(initEscrow(m, now() + 60, { gs: [] }), "BadGroups");
      await fails(initEscrow(m, now() + 60, { gs: Array.from({ length: 9 }, (_, i) => ({ label: label("g" + i), price: SOL(1), fee: SOL(0) })) }), "BadGroups");
      await fails(initEscrow(m, now() + 60, { gs: [groups[0]!, groups[0]!] }), "BadGroups");
      await fails(initEscrow(m, now() + 60, { gs: [{ label: label(""), price: SOL(1), fee: SOL(0) }] }), "BadGroups");
      await fails(initEscrow(m, now() + 60, { gs: [{ label: [119, 108, 0, 120, 0, 0], price: SOL(1), fee: SOL(0) }] }), "BadGroups"); // "wl\0x": not canonical
    });
    it("refuses the escrow's own accounts and program-owned accounts as the payout", async () => {
      await fails(initEscrow(m, now() + 60, { payout: pdas(m.cm).vault }), "BadWallet");
      await fails(initEscrow(m, now() + 60, { payout: configPda }), "BadWallet");
    });
    it("refuses a collection whose update authority is not the creator, and a machine that is not this collection's", async () => {
      const m2 = await buildMachine(1);
      await handOver(m2, stranger.publicKey);
      await fails(initEscrow(m2, now() + 60), "CollectionNotCreators");
      const m3 = await buildMachine(1);
      await fails(initEscrow(m3, now() + 60, { machine: m.cm }), "BadMachine"); // m's machine, m3's collection
      await fails(initEscrow(m3, now() + 60, { machine: configPda }), "BadMachine"); // not a machine at all
    });
    it("refuses every permanent delegate and any external adapter on the collection", async () => {
      for (const plugin of [{ type: "PermanentFreezeDelegate", frozen: false }, { type: "PermanentTransferDelegate" }, { type: "PermanentBurnDelegate" }]) {
        const mx = await buildMachine(1, [plugin]);
        await fails(initEscrow(mx, now() + 60), "CollectionPluginRefused");
      }
      const oracle = { type: "Oracle", resultsOffset: { type: "Anchor" }, baseAddress: umiPk(Keypair.generate().publicKey.toBase58()), lifecycleChecks: { burn: [CheckResult.CAN_REJECT] } };
      const mo = await buildMachine(1, [oracle]);
      await fails(initEscrow(mo, now() + 60), "CollectionPluginRefused");
    });
    it("refuses an update delegate the creator kept: an extra additional delegate, or the plugin under the creator's own key", async () => {
      const extra = await buildMachine(1, [], async (mx) => {
        await updateCollectionPlugin(umiCreator, { collection: umiPk(mx.collection.toBase58()), plugin: { type: "UpdateDelegate", additionalDelegates: [cmAuthorityPda(mx), umiPk(creator.publicKey.toBase58())] } }).sendAndConfirm(umiCreator);
      });
      await fails(initEscrow(extra, now() + 60), "CollectionPluginRefused");
      const kept = await buildMachine(1, [], async (mx) => {
        await approveCollectionPluginAuthority(umiCreator, { collection: umiPk(mx.collection.toBase58()), plugin: { type: "UpdateDelegate" }, newAuthority: { type: "Address", address: umiPk(creator.publicKey.toBase58()) } }).sendAndConfirm(umiCreator);
      });
      await fails(initEscrow(kept, now() + 60), "CollectionPluginRefused");
    });
    it("accepts a collection with royalties and attributes beside the machine's update delegate", async () => {
      const mb = await buildMachine(1, [
        { type: "Royalties", basisPoints: 500, creators: [{ address: umiPk(payout.publicKey.toBase58()), percentage: 100 }], ruleSet: { type: "None" } },
        { type: "Attributes", attributeList: [{ key: "season", value: "1" }] },
      ]);
      const { escrow } = await initEscrow(mb, now() + 60);
      expect(await collectionAuthority(mb)).to.equal(escrow.toBase58());
    });
    it("the squat: nobody but NFI's configured key can co-sign an init, so nobody can take a machine's escrow address", async () => {
      await fails(initEscrow(m, now() + 60, { nfiSigner: stranger }), "NotNfi");
      const { escrow } = await initEscrow(m, now() + 60);
      const e = await program.account.launchEscrow.fetch(escrow);
      expect(e.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
      expect(e.payout.toBase58()).to.equal(payout.publicKey.toBase58());
      expect(await collectionAuthority(m)).to.equal(escrow.toBase58());
    });
  });

  describe("pay is bound to the mint in its transaction", () => {
    let m: Machine, other: Machine, escrow: PublicKey, vault: PublicKey;
    before(async () => { m = await buildMachine(8); other = await buildMachine(2); ({ escrow, vault } = await initEscrow(m, now() + 3600)); });
    it("a payment with no mint is refused (no asset), and so is a payment placed before the mint", async () => {
      await fails(mint(umiA, minterA, m, escrow, vault, { withMint: false }), "AssetNotMinted");
      await fails(mint(umiA, minterA, m, escrow, vault, { payBefore: true }), "AssetNotMinted");
    });
    it("a payment for one asset while minting another is refused", async () => {
      await fails(mint(umiA, minterA, m, escrow, vault, { payAsset: generateSigner(umiA) }), "AssetNotMinted");
    });
    it("a payment by one wallet for a mint to another is refused", async () => {
      await fails(mint(umiA, minterA, m, escrow, vault, { mintMinter: minterB }), "MintNotFound");
    });
    it("paying the cheap group while minting in the dear one is refused", async () => {
      await fails(mint(umiA, minterA, m, escrow, vault, { payGroup: 0, mintGroup: "pub" }), "MintNotFound");
    });
    it("a payment to this escrow with a mint from another machine, or into another collection, is refused", async () => {
      await fails(mint(umiA, minterA, m, escrow, vault, { mintMachine: other }), "AssetNotMinted"); // the asset lands in the other collection
      await fails(mint(umiA, minterA, m, escrow, vault, { mintCollection: other.collection }), "Collection public key mismatch"); // the guard itself refuses first
    });
    it("the wrong amount and an unknown group are refused", async () => {
      await fails(mint(umiA, minterA, m, escrow, vault, { amount: SOL(1) }), "BadAmount");
      await fails(mint(umiA, minterA, m, escrow, vault, { payGroup: 5 }), "BadGroup");
    });
    it("a mint with no pay at all lands (the guard has no price): the permit signer guard is what forbids it in production", async () => {
      await mint(umiA, minterA, m, escrow, vault, { withPay: false });
      const e = await program.account.launchEscrow.fetch(escrow);
      expect(e.receipts.toNumber()).to.equal(0);
    });
    it("the honest transaction pays exactly the group's price plus fee and writes the receipt", async () => {
      const v0 = await bal(vault);
      const a = await mint(umiA, minterA, m, escrow, vault, { payGroup: 0, mintGroup: "wl" });
      expect((await bal(vault)) - v0).to.equal(SOL(0.51).toNumber());
      const r = await program.account.mintReceipt.fetch(receiptPda(escrow, a));
      expect(r.minter.toBase58()).to.equal(minterA.publicKey.toBase58());
      expect(r.group).to.equal(0);
    });
    it("paused blocks pay and only NFI may pause", async () => {
      await fails(setPaused(escrow, true, creator), "NotNfi");
      await setPaused(escrow, true, nfi);
      await fails(mint(umiA, minterA, m, escrow, vault), "Paused");
      await setPaused(escrow, false, nfi);
    });
  });

  describe("the creator's reveal goes through the program while the escrow holds the collection", () => {
    let m: Machine, other: Machine, escrow: PublicKey, vault: PublicKey, a: PublicKey;
    before(async () => { m = await buildMachine(2); other = await buildMachine(1); ({ escrow, vault } = await initEscrow(m, now() + 3600)); a = await mint(umiA, minterA, m, escrow, vault); });
    it("the creator cannot update the asset directly any more; through the program they can; a stranger cannot", async () => {
      const before = await fetchAsset(umiA, umiPk(a.toBase58()));
      const coll = await fetchCollection(umiCreator, umiPk(m.collection.toBase58()));
      await fails(coreUpdate(umiCreator, { asset: before, collection: coll, name: "Hacked" }).sendAndConfirm(umiCreator), "Neither the asset or any plugins have approved this operation");
      await fails(updateAsset(escrow, m, a, "Hacked", null, stranger), "NotCreator");
      await updateAsset(escrow, m, a, "Revealed #1", "https://launch.nfinn.io/spike/r1.json");
      const after = await fetchAsset(umiA, umiPk(a.toBase58()));
      expect(after.name).to.equal("Revealed #1");
      expect(after.uri).to.equal("https://launch.nfinn.io/spike/r1.json");
      expect(after.updateAuthority).to.deep.equal(before.updateAuthority);
    });
    it("an asset from another collection is refused, and the update is refused after a cancel", async () => {
      const { escrow: eo, vault: vo } = await initEscrow(other, now() + 3600);
      const b = await mint(umiB, minterB, other, eo, vo);
      await fails(updateAsset(escrow, m, b, "X", null), "WrongCollection");
      await cancel(escrow, creator);
      await fails(updateAsset(escrow, m, a, "X", null), "NotOpen");
    });
  });

  describe("the happy path: window ends, anyone releases the two legs, the collection comes back, everything closes", () => {
    let m: Machine, escrow: PublicKey, vault: PublicKey, a1: PublicKey, a2: PublicKey;
    it("takes two payments", async () => {
      m = await buildMachine(4);
      ({ escrow, vault } = await initEscrow(m, now() + 9));
      a1 = await mint(umiA, minterA, m, escrow, vault, { payGroup: 0, mintGroup: "wl" });
      a2 = await mint(umiB, minterB, m, escrow, vault, { payGroup: 1, mintGroup: "pub" });
      const e = await program.account.launchEscrow.fetch(escrow);
      expect(e.priceIn.toString()).to.equal(SOL(1.5).toString());
      expect(e.feeIn.toString()).to.equal(SOL(0.03).toString());
      await fails(returnCollection(escrow, m), "NotFinal");
    });
    it("refuses a release before the window ends; after it, pay and cancel are refused and anyone releases the exact split, each leg once, only to the fixed wallets", async () => {
      await fails(release(escrow, vault, stranger), "WindowNotOver");
      await sleep(10000);
      await fails(mint(umiA, minterA, m, escrow, vault), "WindowOver");
      await fails(cancel(escrow, nfi), "WindowOver");
      await fails(releaseFee(escrow, vault, stranger), "NotReleased");
      await fails(release(escrow, vault, stranger, stranger.publicKey), "ConstraintHasOne");
      const p0 = await bal(payout.publicKey), t0 = await bal(treasury.publicKey);
      await release(escrow, vault, stranger);
      expect((await bal(payout.publicKey)) - p0).to.equal(SOL(1.5).toNumber());
      expect(await bal(treasury.publicKey)).to.equal(t0);
      await fails(release(escrow, vault, stranger), "NotOpen");
      await fails(closeEscrow(escrow, vault), "ReceiptsOpen");
      await fails(releaseFee(escrow, vault, stranger, stranger.publicKey), "ConstraintHasOne");
      await releaseFee(escrow, vault, stranger);
      expect((await bal(treasury.publicKey)) - t0).to.equal(SOL(0.03).toNumber());
      await fails(releaseFee(escrow, vault, stranger), "AlreadyReleased");
      await fails(refund(escrow, vault, a1, minterA.publicKey, minterA, m.collection), "NotCancelled");
    });
    it("receipts close to their minters; the collection goes back to the creator; a stray lamport does not block the close; the creator gets the rent and the stray", async () => {
      await closeReceipt(escrow, a1, minterA.publicKey);
      await fails(closeReceipt(escrow, a1, minterA.publicKey), "AccountNotInitialized");
      await closeReceipt(escrow, a2, minterB.publicKey);
      await fails(closeEscrow(escrow, vault), "NotFinal"); // the collection is still the escrow's
      await fails(returnCollection(escrow, m, stranger, stranger.publicKey), "NotCreator"); // only to the creator fixed at init
      await returnCollection(escrow, m, stranger); // by anyone
      expect(await collectionAuthority(m)).to.equal(creator.publicKey.toBase58());
      await fails(returnCollection(escrow, m), "AlreadyReleased");
      const tx = new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: vault, lamports: 1 }));
      await provider.sendAndConfirm(tx, [stranger]);
      await fails(closeEscrow(escrow, vault, stranger), "NotCreator");
      const c0 = await bal(creator.publicKey);
      await closeEscrow(escrow, vault);
      expect(await bal(creator.publicKey)).to.be.greaterThan(c0);
      expect(await conn.getAccountInfo(escrow)).to.equal(null);
      expect(await conn.getAccountInfo(vault)).to.equal(null);
    });
    it("a release with no payments at all works, and the fee leg is not required when no fee came in", async () => {
      const m2 = await buildMachine(1);
      const { escrow: e2, vault: v2 } = await initEscrow(m2, now() + 6);
      await sleep(7000);
      await release(e2, v2, stranger);
      await returnCollection(e2, m2);
      await closeEscrow(e2, v2);
    });
  });

  describe("the cancelled path: whoever gives the asset back is paid, forever", () => {
    let m: Machine, escrow: PublicKey, vault: PublicKey, a1: PublicKey, a2: PublicKey, a3: PublicKey;
    it("a stranger cannot cancel; the creator can; then nothing pays in, nothing releases and the collection stays put", async () => {
      m = await buildMachine(6);
      ({ escrow, vault } = await initEscrow(m, now() + 3600));
      a1 = await mint(umiA, minterA, m, escrow, vault, { payGroup: 0, mintGroup: "wl" });
      a2 = await mint(umiB, minterB, m, escrow, vault);
      a3 = await mint(umiA, minterA, m, escrow, vault);
      await fails(cancel(escrow, stranger), "NotNfi");
      await cancel(escrow, creator);
      const e = await program.account.launchEscrow.fetch(escrow);
      expect(JSON.stringify(e.cancelledBy)).to.include("creator");
      await fails(mint(umiA, minterA, m, escrow, vault), "NotOpen");
      await fails(release(escrow, vault, stranger), "NotOpen");
      await fails(returnCollection(escrow, m), "NotFinal");
    });
    it("a stranger cannot refund an asset they do not hold; a frozen asset fails cleanly and refunds after the thaw; the owner can, the asset burns, price and fee come back", async () => {
      await fails(refund(escrow, vault, a1, minterA.publicKey, stranger, m.collection), "NotOwner");
      const asset = await fetchAsset(umiA, umiPk(a1.toBase58()));
      const coll = await fetchCollection(umiA, umiPk(m.collection.toBase58()));
      await addPlugin(umiA, { asset: asset.publicKey, collection: coll.publicKey, plugin: { type: "FreezeDelegate", frozen: true, authority: { type: "Owner" } } }).sendAndConfirm(umiA);
      await fails(refund(escrow, vault, a1, minterA.publicKey, minterA, m.collection), "Error");
      expect(await burned(a1)).to.equal(false);
      await updatePlugin(umiA, { asset: asset.publicKey, collection: coll.publicKey, plugin: { type: "FreezeDelegate", frozen: false } }).sendAndConfirm(umiA);
      const m0 = await bal(minterA.publicKey);
      await refund(escrow, vault, a1, minterA.publicKey, minterA, m.collection);
      expect((await bal(minterA.publicKey)) - m0).to.be.greaterThan(SOL(0.5).toNumber());
      expect(await burned(a1)).to.equal(true);
      await fails(refund(escrow, vault, a1, minterA.publicKey, minterA, m.collection), "AccountNotInitialized");
    });
    it("after a transfer the original minter is refused and the new owner is the one paid; the rent still returns to the minter", async () => {
      const asset = await fetchAsset(umiA, umiPk(a3.toBase58()));
      const coll = await fetchCollection(umiA, umiPk(m.collection.toBase58()));
      await coreTransfer(umiA, { asset, collection: coll, newOwner: umiPk(minterB.publicKey.toBase58()) }).sendAndConfirm(umiA);
      await fails(refund(escrow, vault, a3, minterA.publicKey, minterA, m.collection), "NotOwner");
      const b0 = await bal(minterB.publicKey), a0 = await bal(minterA.publicKey);
      await refund(escrow, vault, a3, minterA.publicKey, minterB, m.collection);
      expect((await bal(minterB.publicKey)) - b0).to.be.greaterThan(SOL(1).toNumber());
      expect(await bal(minterA.publicKey)).to.be.greaterThan(a0); // the receipt's rent
      expect(await burned(a3)).to.equal(true);
    });
    it("once the owner burned the asset themselves, anyone may crank the refund and the minter is paid; then the collection may go back and the escrow close", async () => {
      const coll = await fetchCollection(umiB, umiPk(m.collection.toBase58()));
      const asset = await fetchAsset(umiB, umiPk(a2.toBase58()));
      await coreBurn(umiB, { asset, collection: coll }).sendAndConfirm(umiB);
      expect(await burned(a2)).to.equal(true);
      const b0 = await bal(minterB.publicKey);
      await refund(escrow, vault, a2, minterB.publicKey, stranger, m.collection);
      expect((await bal(minterB.publicKey)) - b0).to.be.greaterThan(SOL(1.02).toNumber());
      const e = await program.account.launchEscrow.fetch(escrow);
      expect(e.priceRefunded.toString()).to.equal(SOL(2.5).toString());
      expect(e.feeRefunded.toString()).to.equal(SOL(0.05).toString());
      expect(e.receiptsOpen.toNumber()).to.equal(0);
      await returnCollection(escrow, m);
      expect(await collectionAuthority(m)).to.equal(creator.publicKey.toBase58());
      await closeEscrow(escrow, vault);
    });
    it("NFI's cancel: the vault then only ever pays minters (or the owner of a mint paid for someone else), and the escrow closes once every receipt is refunded", async () => {
      const m2 = await buildMachine(3);
      const { escrow: e2, vault: v2 } = await initEscrow(m2, now() + 3600);
      const a = await mint(umiA, minterA, m2, e2, v2);
      const b = await mint(umiB, minterB, m2, e2, v2, { payGroup: 0, mintGroup: "wl" });
      const gift = await mint(umiA, minterA, m2, e2, v2, { owner: minterB.publicKey }); // A pays, B owns
      await cancel(e2, nfi);
      await fails(closeEscrow(e2, v2), "ReceiptsOpen");
      await fails(closeReceipt(e2, a, minterA.publicKey), "NotFinal");
      const t0 = await bal(treasury.publicKey), p0 = await bal(payout.publicKey);
      await refund(e2, v2, a, minterA.publicKey, minterA, m2.collection);
      await fails(closeEscrow(e2, v2), "ReceiptsOpen"); // b unclaimed: forever, until refunded
      await fails(returnCollection(e2, m2), "NotFinal");
      await refund(e2, v2, b, minterB.publicKey, minterB, m2.collection);
      await fails(refund(e2, v2, gift, minterA.publicKey, minterA, m2.collection), "NotOwner"); // the payer does not hold it
      const g0 = await bal(minterB.publicKey);
      await refund(e2, v2, gift, minterA.publicKey, minterB, m2.collection); // the owner gives it back and is paid
      expect((await bal(minterB.publicKey)) - g0).to.be.greaterThan(SOL(1).toNumber());
      expect(await bal(treasury.publicKey)).to.equal(t0);
      expect(await bal(payout.publicKey)).to.equal(p0);
      await fails(closeEscrow(e2, v2), "NotFinal"); // the collection first
      await returnCollection(e2, m2);
      await closeEscrow(e2, v2);
      expect(await conn.getAccountInfo(e2)).to.equal(null);
    });
  });

  describe("rotating NFI's key revokes the old one on every live escrow", () => {
    it("after update_config the old key can neither cancel, pause nor co-sign an init; the new key can cancel an escrow made under the old one", async () => {
      const m = await buildMachine(1);
      const { escrow } = await initEscrow(m, now() + 3600);
      await program.methods.updateConfig(nfi2.publicKey).accounts({ config: configPda, authority: authority.publicKey, treasury: treasury.publicKey }).rpc();
      await fails(setPaused(escrow, true, nfi), "NotNfi");
      await fails(cancel(escrow, nfi), "NotNfi");
      const m2 = await buildMachine(1);
      await fails(initEscrow(m2, now() + 3600), "NotNfi");
      await setPaused(escrow, true, nfi2);
      await cancel(escrow, nfi2);
      const e = await program.account.launchEscrow.fetch(escrow);
      expect(JSON.stringify(e.cancelledBy)).to.include("nfi");
      expect(e.nfiAuthority.toBase58()).to.equal(nfi.publicKey.toBase58()); // the record of who signed at init
      await program.methods.updateConfig(nfi.publicKey).accounts({ config: configPda, authority: authority.publicKey, treasury: treasury.publicKey }).rpc();
    });
  });
  describe("the bot tax guard and pay in the same transaction (why the service never pairs them)", () => {
    // A taxed mint SUCCEEDS as a transaction without creating the asset, and pay has already moved the money: a payment with
    // nothing to refund against. This fixture (a mainnet dump) lets the taxed mint through; the devnet guard refuses the pay
    // program outright (UnauthorizedProgramFound). Either way an escrow launch must carry no bot tax; the service enforces it.
    it("with a bot tax the taxed mint creates no asset, so pay fails and the whole transaction reverts: no payment without the NFT", async () => {
      const taxed = await buildMachine(2, [], undefined, { base: { botTax: some({ lamports: sol(0.005), lastInstruction: true }) } });
      const { escrow: e1, vault: v1 } = await initEscrow(taxed, now() + 3600);
      let out = "";
      try { await mint(umiA, minterA, taxed, e1, v1); out = "minted"; } catch (e: any) { out = String(e.message ?? e); }
      console.log("        bot tax alone:", out.slice(0, 120));
      const gated = await buildMachine(2, [], undefined, { base: { botTax: some({ lamports: sol(0.005), lastInstruction: true }) }, group: { programGate: some({ additional: [umiPk(program.programId.toBase58())] }) } });
      const { escrow: e2, vault: v2 } = await initEscrow(gated, now() + 3600);
      let out2 = "";
      try { await mint(umiA, minterA, gated, e2, v2); out2 = "minted"; } catch (e: any) { out2 = String(e.message ?? e); }
      console.log("        bot tax + program gate:", out2.slice(0, 120));
      const e = await program.account.launchEscrow.fetch(e2);
      console.log("        gated escrow receipts:", e.receipts.toNumber());
      const e1s = await program.account.launchEscrow.fetch(e1);
      expect(e1s.receipts.toNumber() + e.receipts.toNumber(), "no receipt may exist without its asset").to.equal([out, out2].filter((x) => x === "minted").length);
    });
  });
});
