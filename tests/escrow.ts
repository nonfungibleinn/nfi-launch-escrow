// nfi_launch_escrow on a local validator with the real Core Candy Machine and Candy Guard programs, built with
// --features test (a 5 s minimum window). Every payment travels in the same transaction as the guard's mint_v1, the way
// NFI's permit builder sends it. The happy path and every attack the design and the first review list: a payment with
// no mint, with another asset's mint, in another group, from another machine; wrong amounts; paused; late pay; the
// squat; early release; cancel after the window; wrong-party cancel and pause; refunds by strangers, by the current
// owner after a transfer, and the crank on a burned shell; closing with an unclaimed receipt; stray lamports.
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { generateSigner, keypairIdentity, publicKey as umiPk, some, none, transactionBuilder, type Umi, type KeypairSigner } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, fromWeb3JsInstruction, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { setComputeUnitLimit } from "@metaplex-foundation/mpl-toolbox";
import { burn as coreBurn, transfer as coreTransfer, createCollection as createCoreCollection, fetchAsset, fetchCollection, mplCore } from "@metaplex-foundation/mpl-core";
import { addConfigLines, create as createMachine, findCandyGuardPda, mintV1, mplCandyMachine } from "@metaplex-foundation/mpl-core-candy-machine";
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
  const buildMachine = async (items = 6): Promise<Machine> => {
    const coll = generateSigner(umiCreator);
    await createCoreCollection(umiCreator, { collection: coll, name: "Launch", uri: "https://launch.nfinn.io/spike/1.json" }).sendAndConfirm(umiCreator);
    const cm = generateSigner(umiCreator);
    const b = await createMachine(umiCreator, {
      candyMachine: cm, collection: coll.publicKey, collectionUpdateAuthority: umiCreator.identity, itemsAvailable: items,
      configLineSettings: some({ prefixName: "Item #", nameLength: 4, prefixUri: "https://launch.nfinn.io/spike/", uriLength: 8, isSequential: false }),
      guards: {}, groups: [{ label: "wl", guards: {} }, { label: "pub", guards: {} }],
    });
    await b.sendAndConfirm(umiCreator);
    await addConfigLines(umiCreator, { candyMachine: cm.publicKey, index: 0, configLines: Array.from({ length: items }, (_, i) => ({ name: String(i + 1), uri: `${(i % 5) + 1}.json` })) }).sendAndConfirm(umiCreator);
    return { cm: toWeb3JsPublicKey(cm.publicKey), guard: toWeb3JsPublicKey(findCandyGuardPda(umiCreator, { base: cm.publicKey })[0]), collection: toWeb3JsPublicKey(coll.publicKey) };
  };
  const groups = [{ label: label("wl"), price: SOL(0.5), fee: SOL(0.01) }, { label: label("pub"), price: SOL(1), fee: SOL(0.02) }];
  const initEscrow = async (m: Machine, windowEnd: number, o: { nfiSigner?: Keypair; gs?: typeof groups; payout?: PublicKey } = {}) => {
    const { escrow, vault } = pdas(m.cm);
    await program.methods.init({ payout: o.payout ?? payout.publicKey, candyGuard: m.guard, collection: m.collection, windowEnd: new BN(windowEnd), groups: o.gs ?? groups })
      .accounts({ config: configPda, escrow, vault, candyMachine: m.cm, creator: creator.publicKey, nfiAuthority: (o.nfiSigner ?? nfi).publicKey, systemProgram: SystemProgram.programId })
      .signers([creator, o.nfiSigner ?? nfi]).rpc();
    return { escrow, vault };
  };
  /** The mint transaction as the permit builder sends it: compute budget, pay, mint_v1. Returns the asset. */
  const mint = async (umi: Umi, minter: Keypair, m: Machine, escrow: PublicKey, vault: PublicKey, o: { payGroup?: number; mintGroup?: string; amount?: BN; payAsset?: KeypairSigner; withPay?: boolean; withMint?: boolean; mintMachine?: Machine } = {}) => {
    const asset = generateSigner(umi);
    const payAsset = o.payAsset ?? asset;
    const g = o.payGroup ?? 1;
    const gg = groups[Math.min(g, groups.length - 1)]!;
    const amount = o.amount ?? new BN(gg.price.toString()).add(new BN(gg.fee.toString()));
    let b = transactionBuilder().add(setComputeUnitLimit(umi, { units: 800_000 }));
    if (o.withPay !== false) {
      const ix = await program.methods.pay(g, amount).accounts({ escrow, vault, receipt: receiptPda(escrow, toWeb3JsPublicKey(payAsset.publicKey)), asset: toWeb3JsPublicKey(payAsset.publicKey), minter: minter.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId }).instruction();
      b = b.add({ instruction: fromWeb3JsInstruction(ix), signers: [payAsset], bytesCreatedOnChain: 0 });
    }
    if (o.withMint !== false) {
      const mm = o.mintMachine ?? m;
      b = b.add(mintV1(umi, { candyMachine: umiPk(mm.cm.toBase58()), candyGuard: umiPk(mm.guard.toBase58()), collection: umiPk(mm.collection.toBase58()), asset, group: o.mintGroup === "" ? none() : some(o.mintGroup ?? "pub"), mintArgs: {} }));
    }
    await b.sendAndConfirm(umi);
    return toWeb3JsPublicKey(asset.publicKey);
  };
  const refund = (escrow: PublicKey, vault: PublicKey, asset: PublicKey, minter: PublicKey, signer: Keypair, coll: PublicKey) =>
    program.methods.refund().accounts({ escrow, vault, receipt: receiptPda(escrow, asset), minter, asset, collection: coll, signer: signer.publicKey, mplCoreProgram: CORE, systemProgram: SystemProgram.programId }).signers([signer]).rpc();
  const release = (escrow: PublicKey, vault: PublicKey, signer: Keypair) =>
    program.methods.release().accounts({ escrow, vault, payout: payout.publicKey, treasury: treasury.publicKey, signer: signer.publicKey }).signers([signer]).rpc();
  const now = () => Math.floor(Date.now() / 1000);

  before(async () => {
    await Promise.all([airdrop(creator.publicKey, 50), airdrop(nfi.publicKey, 2), airdrop(minterA.publicKey, 20), airdrop(minterB.publicKey, 20), airdrop(stranger.publicKey, 5), airdrop(payout.publicKey, 1), airdrop(treasury.publicKey, 1)]);
    for (let i = 0; i < 40 && (await bal(creator.publicKey)) === 0; i++) await sleep(250);
  });

  describe("config", () => {
    it("only the upgrade authority may create it; then NFI's key and the treasury are fixed there", async () => {
      const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_LOADER_UPGRADEABLE);
      await fails(program.methods.initConfig(nfi.publicKey, treasury.publicKey).accounts({ config: configPda, authority: stranger.publicKey, program: program.programId, programData, systemProgram: SystemProgram.programId }).signers([stranger]).rpc(), "NotAuthority");
      await program.methods.initConfig(nfi.publicKey, treasury.publicKey).accounts({ config: configPda, authority: authority.publicKey, program: program.programId, programData, systemProgram: SystemProgram.programId }).rpc();
      const c = await program.account.config.fetch(configPda);
      expect(c.nfiAuthority.toBase58()).to.equal(nfi.publicKey.toBase58());
      await fails(program.methods.updateConfig(nfi.publicKey, treasury.publicKey).accounts({ config: configPda, authority: stranger.publicKey }).signers([stranger]).rpc(), "NotAuthority");
    });
  });

  describe("init", () => {
    let m: Machine;
    before(async () => { m = await buildMachine(2); });
    it("refuses bad windows, no groups, nine groups, duplicate labels, an empty label", async () => {
      await fails(initEscrow(m, now() + 1), "BadWindow");
      await fails(initEscrow(m, now() + 91 * 86400), "BadWindow");
      await fails(initEscrow(m, now() + 60, { gs: [] }), "BadGroups");
      await fails(initEscrow(m, now() + 60, { gs: Array.from({ length: 9 }, (_, i) => ({ label: label("g" + i), price: SOL(1), fee: SOL(0) })) }), "BadGroups");
      await fails(initEscrow(m, now() + 60, { gs: [groups[0]!, groups[0]!] }), "BadGroups");
      await fails(initEscrow(m, now() + 60, { gs: [{ label: label(""), price: SOL(1), fee: SOL(0) }] }), "BadGroups");
    });
    it("refuses the escrow's own accounts as the payout", async () => {
      await fails(initEscrow(m, now() + 60, { payout: pdas(m.cm).vault }), "BadWallet");
    });
    it("the squat: nobody but NFI's configured key can co-sign an init, so nobody can take a machine's escrow address", async () => {
      await fails(initEscrow(m, now() + 60, { nfiSigner: stranger }), "NotNfi");
      const { escrow } = await initEscrow(m, now() + 60);
      const e = await program.account.launchEscrow.fetch(escrow);
      expect(e.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
    });
  });

  describe("pay is bound to the mint in its transaction", () => {
    let m: Machine, other: Machine, escrow: PublicKey, vault: PublicKey;
    before(async () => { m = await buildMachine(8); other = await buildMachine(2); ({ escrow, vault } = await initEscrow(m, now() + 3600)); });
    it("a payment with no mint after it is refused", async () => {
      await fails(mint(umiA, minterA, m, escrow, vault, { withMint: false }), "MintNotFound");
    });
    it("a payment for one asset while minting another is refused", async () => {
      await fails(mint(umiA, minterA, m, escrow, vault, { payAsset: generateSigner(umiA) }), "MintNotFound");
    });
    it("paying the cheap group while minting in the dear one is refused", async () => {
      await fails(mint(umiA, minterA, m, escrow, vault, { payGroup: 0, mintGroup: "pub" }), "MintNotFound");
    });
    it("a payment to this escrow with a mint from another machine is refused", async () => {
      await fails(mint(umiA, minterA, m, escrow, vault, { mintMachine: other }), "MintNotFound");
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
      await fails(program.methods.setPaused(true).accounts({ escrow, nfiAuthority: creator.publicKey }).signers([creator]).rpc(), "NotNfi");
      await program.methods.setPaused(true).accounts({ escrow, nfiAuthority: nfi.publicKey }).signers([nfi]).rpc();
      await fails(mint(umiA, minterA, m, escrow, vault), "Paused");
      await program.methods.setPaused(false).accounts({ escrow, nfiAuthority: nfi.publicKey }).signers([nfi]).rpc();
    });
  });

  describe("the happy path: window ends, anyone releases, everything closes", () => {
    let m: Machine, escrow: PublicKey, vault: PublicKey, a1: PublicKey, a2: PublicKey;
    it("takes two payments", async () => {
      m = await buildMachine(4);
      ({ escrow, vault } = await initEscrow(m, now() + 9));
      a1 = await mint(umiA, minterA, m, escrow, vault, { payGroup: 0, mintGroup: "wl" });
      a2 = await mint(umiB, minterB, m, escrow, vault, { payGroup: 1, mintGroup: "pub" });
      const e = await program.account.launchEscrow.fetch(escrow);
      expect(e.priceIn.toString()).to.equal(SOL(1.5).toString());
      expect(e.feeIn.toString()).to.equal(SOL(0.03).toString());
    });
    it("refuses a release before the window ends; after it, pay and cancel are refused and anyone releases the exact split", async () => {
      await fails(release(escrow, vault, stranger), "WindowNotOver");
      await sleep(10000);
      await fails(mint(umiA, minterA, m, escrow, vault), "WindowOver");
      await fails(program.methods.cancel().accounts({ escrow, signer: nfi.publicKey }).signers([nfi]).rpc(), "WindowOver");
      const p0 = await bal(payout.publicKey), t0 = await bal(treasury.publicKey);
      await release(escrow, vault, stranger);
      expect((await bal(payout.publicKey)) - p0).to.equal(SOL(1.5).toNumber());
      expect((await bal(treasury.publicKey)) - t0).to.equal(SOL(0.03).toNumber());
      await fails(release(escrow, vault, stranger), "NotOpen");
      await fails(refund(escrow, vault, a1, minterA.publicKey, minterA, m.collection), "NotCancelled");
    });
    it("receipts close to their minters; a stray lamport does not block the close; the creator gets the rent and the stray", async () => {
      await fails(program.methods.closeEscrow().accounts({ escrow, vault, creator: creator.publicKey }).signers([creator]).rpc(), "ReceiptsOpen");
      await program.methods.closeReceipt().accounts({ escrow, receipt: receiptPda(escrow, a1), minter: minterA.publicKey, signer: stranger.publicKey }).signers([stranger]).rpc();
      await program.methods.closeReceipt().accounts({ escrow, receipt: receiptPda(escrow, a2), minter: minterB.publicKey, signer: stranger.publicKey }).signers([stranger]).rpc();
      const tx = new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: vault, lamports: 1 }));
      await provider.sendAndConfirm(tx, [stranger]);
      await fails(program.methods.closeEscrow().accounts({ escrow, vault, creator: stranger.publicKey }).signers([stranger]).rpc(), "NotCreator");
      const c0 = await bal(creator.publicKey);
      await program.methods.closeEscrow().accounts({ escrow, vault, creator: creator.publicKey }).signers([creator]).rpc();
      expect(await bal(creator.publicKey)).to.be.greaterThan(c0);
      expect(await conn.getAccountInfo(escrow)).to.equal(null);
      expect(await conn.getAccountInfo(vault)).to.equal(null);
    });
    it("a release with no payments at all works", async () => {
      const m2 = await buildMachine(1);
      const { escrow: e2, vault: v2 } = await initEscrow(m2, now() + 6);
      await sleep(7000);
      await release(e2, v2, stranger);
      await program.methods.closeEscrow().accounts({ escrow: e2, vault: v2, creator: creator.publicKey }).signers([creator]).rpc();
    });
  });

  describe("the cancelled path: whoever gives the asset back is paid, forever", () => {
    let m: Machine, escrow: PublicKey, vault: PublicKey, a1: PublicKey, a2: PublicKey, a3: PublicKey;
    it("a stranger cannot cancel; the creator can; then nothing pays in and nothing releases", async () => {
      m = await buildMachine(6);
      ({ escrow, vault } = await initEscrow(m, now() + 3600));
      a1 = await mint(umiA, minterA, m, escrow, vault, { payGroup: 0, mintGroup: "wl" });
      a2 = await mint(umiB, minterB, m, escrow, vault);
      a3 = await mint(umiA, minterA, m, escrow, vault);
      await fails(program.methods.cancel().accounts({ escrow, signer: stranger.publicKey }).signers([stranger]).rpc(), "NotNfi");
      await program.methods.cancel().accounts({ escrow, signer: creator.publicKey }).signers([creator]).rpc();
      const e = await program.account.launchEscrow.fetch(escrow);
      expect(JSON.stringify(e.cancelledBy)).to.include("creator");
      await fails(mint(umiA, minterA, m, escrow, vault), "NotOpen");
      await fails(release(escrow, vault, stranger), "NotOpen");
    });
    it("a stranger cannot refund an asset they do not hold; the owner can, the asset burns, price and fee come back", async () => {
      await fails(refund(escrow, vault, a1, minterA.publicKey, stranger, m.collection), "NotOwner");
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
    it("once the owner burned the asset themselves, anyone may crank the refund and the minter is paid", async () => {
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
    });
    it("NFI's cancel: the vault then only ever pays minters, and the escrow closes once every receipt is refunded", async () => {
      const m2 = await buildMachine(2);
      const { escrow: e2, vault: v2 } = await initEscrow(m2, now() + 3600);
      const a = await mint(umiA, minterA, m2, e2, v2);
      const b = await mint(umiB, minterB, m2, e2, v2, { payGroup: 0, mintGroup: "wl" });
      await program.methods.cancel().accounts({ escrow: e2, signer: nfi.publicKey }).signers([nfi]).rpc();
      await fails(program.methods.closeEscrow().accounts({ escrow: e2, vault: v2, creator: creator.publicKey }).signers([creator]).rpc(), "ReceiptsOpen");
      await fails(program.methods.closeReceipt().accounts({ escrow: e2, receipt: receiptPda(e2, a), minter: minterA.publicKey, signer: stranger.publicKey }).signers([stranger]).rpc(), "NotFinal");
      const t0 = await bal(treasury.publicKey), p0 = await bal(payout.publicKey);
      await refund(e2, v2, a, minterA.publicKey, minterA, m2.collection);
      await fails(program.methods.closeEscrow().accounts({ escrow: e2, vault: v2, creator: creator.publicKey }).signers([creator]).rpc(), "ReceiptsOpen"); // b unclaimed: forever, until refunded
      await refund(e2, v2, b, minterB.publicKey, minterB, m2.collection);
      expect(await bal(treasury.publicKey)).to.equal(t0);
      expect(await bal(payout.publicKey)).to.equal(p0);
      await program.methods.closeEscrow().accounts({ escrow: e2, vault: v2, creator: creator.publicKey }).signers([creator]).rpc();
      expect(await conn.getAccountInfo(e2)).to.equal(null);
    });
  });
});
