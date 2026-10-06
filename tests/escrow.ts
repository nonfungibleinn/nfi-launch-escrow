// nfi_launch_escrow on a local validator with the real MPL Core, Core Candy Machine and Candy Guard programs, built with
// --features test (a 5 s minimum window, 6 s grace periods). Round-4 design: the escrow is the machine's authority and
// mint authority, so pay_and_mint (payment + receipt + mint in one instruction) is the only way to mint. Covers the happy
// path and the round-4 findings: no mint without payment, through the guard, or straight from the machine (L-001/L-002);
// fresh assets only, empty collections only (L-004); refunds after Core's Collect (L-005); NFI's hot key cannot cancel
// (L-006); the cancel grace (L-011); the payout signs (L-012); the reveal commitment (L-013, L-025); plugin authorities
// (L-014); unfunded wallets (L-036); phases, allocations and per-wallet limits on chain; the config keys.
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY, Transaction } from "@solana/web3.js";
import { createHash } from "crypto";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { generateSigner, keypairIdentity, publicKey as umiPk, some, none, type Umi } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { addCollectionPlugin, addPlugin, approveCollectionPluginAuthority, burn as coreBurn, CheckResult, collect, create as coreCreate, createCollection as createCoreCollection, fetchAsset, fetchCollection, mplCore, transfer as coreTransfer, update as coreUpdate, updateCollectionPlugin, updatePlugin, updateCollectionV1 } from "@metaplex-foundation/mpl-core";
import { addConfigLines, create as createMachine, findCandyGuardPda, findCandyMachineAuthorityPda, fetchCandyMachine, mintAssetFromCandyMachine, mintV1, mplCandyMachine, setMintAuthority } from "@metaplex-foundation/mpl-core-candy-machine";
import { expect } from "chai";
import type { NfiLaunchEscrow } from "../target/types/nfi_launch_escrow";

const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const CANDY_MACHINE = new PublicKey("CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J");
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const label = (s: string) => { const b = Buffer.alloc(6); b.write(s); return Array.from(b); };
const SOL = (n: number) => new BN(Math.round(n * LAMPORTS_PER_SOL));
const ZERO32 = Array.from(Buffer.alloc(32));

// ---- the reveal commitment, exactly as the program hashes it ----
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const sha = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
export const revealLeaf = (i: number, name: string, uri: string) => sha(Buffer.from([0]), u64(i), u32(Buffer.byteLength(name)), Buffer.from(name), u32(Buffer.byteLength(uri)), Buffer.from(uri));
const node = (a: Buffer, b: Buffer) => (Buffer.compare(a, b) <= 0 ? sha(Buffer.from([1]), a, b) : sha(Buffer.from([1]), b, a));
/** Root and per-leaf proofs; an odd node is carried up unchanged (so its proof has no entry for that level). */
export const revealTree = (leaves: Buffer[]) => {
  const proofs: Buffer[][] = leaves.map(() => []);
  let level = leaves.map((h, i) => ({ h, members: [i] }));
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!, b = level[i + 1];
      if (!b) { next.push(a); continue; }
      a.members.forEach((m) => proofs[m]!.push(b.h));
      b.members.forEach((m) => proofs[m]!.push(a.h));
      next.push({ h: node(a.h, b.h), members: [...a.members, ...b.members] });
    }
    level = next;
  }
  return { root: level[0]!.h, proofs };
};

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
  const canceller = Keypair.generate();
  const permit = Keypair.generate();
  const minterA = Keypair.generate();
  const minterB = Keypair.generate();
  const stranger = Keypair.generate();
  const payout = Keypair.generate();
  const treasury = Keypair.generate();
  const airdrop = async (pk: PublicKey, sol = 10) => { const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction(sig, "confirmed"); };
  const bal = (pk: PublicKey) => conn.getBalance(pk, "confirmed");
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config2")], program.programId);
  const pdas = (cm: PublicKey) => {
    const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("launch"), cm.toBuffer()], program.programId);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), escrow.toBuffer()], program.programId);
    return { escrow, vault };
  };
  const receiptPda = (escrow: PublicKey, asset: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("receipt"), escrow.toBuffer(), asset.toBuffer()], program.programId)[0];
  const counterPda = (escrow: PublicKey, minter: PublicKey, g: number) => PublicKey.findProgramAddressSync([Buffer.from("minted"), escrow.toBuffer(), minter.toBuffer(), Buffer.from([g])], program.programId)[0];
  const errText = (e: any) => String(e?.message ?? e) + JSON.stringify(e?.logs ?? e?.transactionLogs ?? []) + String(e?.cause ?? "");
  const fails = async (p: Promise<unknown>, needle: string) => { try { await p; } catch (e: any) { const m = errText(e); expect(m, `expected "${needle}" in: ${m.slice(0, 500)}`).to.include(needle); return; } expect.fail(`expected failure: ${needle}`); };
  const now = () => Math.floor(Date.now() / 1000);

  const umiFor = (kp: Keypair): Umi => createUmi(conn.rpcEndpoint, { commitment: "confirmed" }).use(mplCore()).use(mplCandyMachine()).use(keypairIdentity(fromWeb3JsKeypair(kp)));
  const umiCreator = umiFor(creator);
  const umiA = umiFor(minterA);
  const umiB = umiFor(minterB);
  const pk = (p: PublicKey) => umiPk(p.toBase58());

  type Machine = { cm: PublicKey; guard: PublicKey; collection: PublicKey; authorityPda: PublicKey; hidden: boolean };
  /** A collection and a Core candy machine (wrapped by a guard, as the SDK makes it: init takes the mint authority over). */
  const buildMachine = async (o: { items?: number; plugins?: any[]; hidden?: boolean; after?: (m: Machine) => Promise<void> } = {}): Promise<Machine> => {
    const items = o.items ?? 6;
    const coll = generateSigner(umiCreator);
    await createCoreCollection(umiCreator, { collection: coll, name: "Launch", uri: "https://launch.nfinn.io/spike/1.json", plugins: o.plugins ?? [] }).sendAndConfirm(umiCreator);
    const cm = generateSigner(umiCreator);
    const b = await createMachine(umiCreator, {
      candyMachine: cm, collection: coll.publicKey, collectionUpdateAuthority: umiCreator.identity, itemsAvailable: items,
      configLineSettings: o.hidden ? none() : some({ prefixName: "Item #", nameLength: 4, prefixUri: "https://launch.nfinn.io/spike/", uriLength: 8, isSequential: false }),
      hiddenSettings: o.hidden ? some({ name: "Hidden #$ID$", uri: "https://launch.nfinn.io/spike/hidden.json", hash: new Uint8Array(32) }) : none(),
      guards: {},
    });
    await b.sendAndConfirm(umiCreator);
    if (!o.hidden) await addConfigLines(umiCreator, { candyMachine: cm.publicKey, index: 0, configLines: Array.from({ length: items }, (_, i) => ({ name: String(i + 1), uri: `${(i % 5) + 1}.json` })) }).sendAndConfirm(umiCreator);
    const m: Machine = {
      cm: toWeb3JsPublicKey(cm.publicKey), guard: toWeb3JsPublicKey(findCandyGuardPda(umiCreator, { base: cm.publicKey })[0]), collection: toWeb3JsPublicKey(coll.publicKey),
      authorityPda: toWeb3JsPublicKey(findCandyMachineAuthorityPda(umiCreator, { candyMachine: cm.publicKey })[0]), hidden: Boolean(o.hidden),
    };
    if (o.after) await o.after(m);
    return m;
  };
  const collectionAuthority = async (m: Machine) => (await fetchCollection(umiCreator, pk(m.collection))).updateAuthority.toString();
  type G = { label: number[]; price: BN; fee: BN; start: BN; end: BN; perWallet: number; allocation: number };
  const grp = (l: string, price: number, fee: number, o: Partial<{ start: number; end: number; perWallet: number; allocation: number }> = {}): G =>
    ({ label: label(l), price: SOL(price), fee: SOL(fee), start: new BN(o.start ?? 0), end: new BN(o.end ?? 0), perWallet: o.perWallet ?? 0, allocation: o.allocation ?? 0 });
  const groups = () => [grp("wl", 0.5, 0.01), grp("pub", 1, 0.02)];
  type L = { m: Machine; escrow: PublicKey; vault: PublicKey };
  const initEscrow = async (m: Machine, windowEnd: number, o: { nfiSigner?: Keypair; gs?: G[]; payout?: Keypair; machine?: PublicKey; root?: number[]; permit?: PublicKey } = {}): Promise<L> => {
    const { escrow, vault } = pdas(o.machine ?? m.cm);
    const pay = o.payout ?? payout;
    await program.methods.init({ windowEnd: new BN(windowEnd), groups: o.gs ?? groups(), permit: o.permit ?? permit.publicKey, revealRoot: o.root ?? ZERO32 })
      .accounts({ config: configPda, escrow, vault, candyMachine: o.machine ?? m.cm, collection: m.collection, payout: pay.publicKey, creator: creator.publicKey, nfiAuthority: (o.nfiSigner ?? nfi).publicKey, candyMachineProgram: CANDY_MACHINE, mplCoreProgram: CORE, systemProgram: SystemProgram.programId } as any)
      .signers([creator, o.nfiSigner ?? nfi, ...(pay.publicKey.equals(creator.publicKey) ? [] : [pay])]).rpc();
    return { m, escrow, vault };
  };
  /** The mint transaction as the permit builder sends it: compute budget, pay_and_mint. Returns the asset. */
  const mint = async (L: L, minter: Keypair, g = 1, o: { permitSigner?: Keypair; asset?: Keypair } = {}) => {
    const asset = o.asset ?? Keypair.generate();
    const ps = o.permitSigner ?? permit;
    await program.methods.payAndMint(g)
      .accounts({
        escrow: L.escrow, vault: L.vault, receipt: receiptPda(L.escrow, asset.publicKey), counter: counterPda(L.escrow, minter.publicKey, g), asset: asset.publicKey, minter: minter.publicKey,
        permit: ps.publicKey, candyMachine: L.m.cm, candyMachineAuthority: L.m.authorityPda, collection: L.m.collection, candyMachineProgram: CANDY_MACHINE, mplCoreProgram: CORE,
        systemProgram: SystemProgram.programId, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
      } as any)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .signers([asset, minter, ps]).rpc();
    return asset.publicKey;
  };
  const refund = (L: L, asset: PublicKey, minter: PublicKey, signer: Keypair, coll = L.m.collection) =>
    program.methods.refund().accounts({ escrow: L.escrow, vault: L.vault, receipt: receiptPda(L.escrow, asset), minter, asset, collection: coll, signer: signer.publicKey, mplCoreProgram: CORE, systemProgram: SystemProgram.programId } as any).signers([signer]).rpc();
  const release = (L: L, signer = stranger, to = payout.publicKey) => program.methods.release().accounts({ escrow: L.escrow, vault: L.vault, payout: to, signer: signer.publicKey } as any).signers([signer]).rpc();
  const releaseFee = (L: L, signer = stranger, to = treasury.publicKey) => program.methods.releaseFee().accounts({ escrow: L.escrow, vault: L.vault, treasury: to, signer: signer.publicKey } as any).signers([signer]).rpc();
  const cancel = (L: L, signer: Keypair) => program.methods.cancel().accounts({ config: configPda, escrow: L.escrow, signer: signer.publicKey } as any).signers([signer]).rpc();
  const setPaused = (L: L, paused: boolean, signer = nfi) => program.methods.setPaused(paused).accounts({ config: configPda, escrow: L.escrow, nfiAuthority: signer.publicKey } as any).signers([signer]).rpc();
  const setPermit = (L: L, p: PublicKey, signer = nfi) => program.methods.setPermit(p).accounts({ config: configPda, escrow: L.escrow, nfiAuthority: signer.publicKey } as any).signers([signer]).rpc();
  const setGroup = (L: L, g: number, start: number, end: number, perWallet: number, allocation: number, signers: Keypair[] = [nfi, creator]) =>
    program.methods.setGroup(g, new BN(start), new BN(end), perWallet, allocation).accounts({ config: configPda, escrow: L.escrow, nfiAuthority: signers[0]!.publicKey, creator: signers[1]!.publicKey } as any).signers(signers).rpc();
  const returnCollection = (L: L, signer = stranger) =>
    program.methods.returnCollection().accounts({ escrow: L.escrow, collection: L.m.collection, candyMachine: L.m.cm, creator: creator.publicKey, payer: signer.publicKey, candyMachineProgram: CANDY_MACHINE, mplCoreProgram: CORE, systemProgram: SystemProgram.programId } as any).signers([signer]).rpc();
  const reveal = (L: L, asset: PublicKey, name: string, uri: string, proof: Buffer[], signer = stranger) =>
    program.methods.reveal(name, uri, proof.map((p) => Array.from(p))).accounts({ escrow: L.escrow, receipt: receiptPda(L.escrow, asset), asset, collection: L.m.collection, candyMachine: L.m.cm, payer: signer.publicKey, mplCoreProgram: CORE, systemProgram: SystemProgram.programId } as any).signers([signer]).rpc();
  const closeEscrow = (L: L, signer = creator) => program.methods.closeEscrow().accounts({ escrow: L.escrow, vault: L.vault, creator: signer.publicKey } as any).signers([signer]).rpc();
  const closeReceipt = (L: L, asset: PublicKey, minter: PublicKey) => program.methods.closeReceipt().accounts({ escrow: L.escrow, receipt: receiptPda(L.escrow, asset), minter, signer: stranger.publicKey } as any).signers([stranger]).rpc();
  const closeCounter = (L: L, minter: PublicKey, g: number) => program.methods.closeCounter().accounts({ escrow: L.escrow, counter: counterPda(L.escrow, minter, g), minter, signer: stranger.publicKey } as any).signers([stranger]).rpc();
  const waitUntil = async (t: number) => { while (now() <= t) await sleep(500); await sleep(1500); };

  before(async () => {
    // Core's Collect pays these two fixed fee recipients; on a fresh validator they must exist first.
    await Promise.all(["8AT6o8Qk5T9QnZvPThMrF9bcCQLTGkyGvVZZzHgCw11v", "MmHsqX4LxTfifxoH8BVRLUKrwDn1LPCac6YcCZTHhwt"].map((k) => airdrop(new PublicKey(k), 1)));
    await Promise.all([airdrop(creator.publicKey, 60), airdrop(nfi.publicKey, 2), airdrop(nfi2.publicKey, 2), airdrop(canceller.publicKey, 2), airdrop(minterA.publicKey, 30), airdrop(minterB.publicKey, 30), airdrop(stranger.publicKey, 5), airdrop(payout.publicKey, 1), airdrop(treasury.publicKey, 1)]);
  });

  describe("config", () => {
    const [programData] = PublicKey.findProgramAddressSync([new PublicKey("3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n").toBuffer()], BPF_LOADER_UPGRADEABLE);
    const initConfig = (auth: Keypair, treas: PublicKey, hot = nfi.publicKey, cold = canceller.publicKey) =>
      program.methods.initConfig(hot, cold).accounts({ config: configPda, authority: auth.publicKey, program: program.programId, programData, treasury: treas, systemProgram: SystemProgram.programId } as any).signers([auth]).rpc();
    it("only the upgrade authority creates it; the treasury must be a funded plain wallet; the hot key and the canceller must differ", async () => {
      await fails(initConfig(stranger, treasury.publicKey), "NotAuthority");
      await fails(initConfig(authority, programData), "BadWallet");
      await fails(initConfig(authority, Keypair.generate().publicKey), "WalletUnfunded"); // L-036: a treasury that could refuse a small credit
      await fails(initConfig(authority, treasury.publicKey, nfi.publicKey, nfi.publicKey), "BadConfig");
      await initConfig(authority, treasury.publicKey);
      const c = await program.account.config.fetch(configPda);
      expect(c.nfiAuthority.toBase58()).to.equal(nfi.publicKey.toBase58());
      expect(c.canceller.toBase58()).to.equal(canceller.publicKey.toBase58());
      expect(c.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
    });
    it("each key is changed on its own, by the config authority only", async () => {
      await fails(program.methods.setNfiAuthority(nfi2.publicKey).accounts({ config: configPda, authority: stranger.publicKey } as any).signers([stranger]).rpc(), "NotAuthority");
      await fails(program.methods.setCanceller(nfi.publicKey).accounts({ config: configPda, authority: authority.publicKey } as any).rpc(), "BadConfig");
      await fails(program.methods.setTreasury().accounts({ config: configPda, authority: authority.publicKey, treasury: configPda } as any).rpc(), "BadWallet");
      await program.methods.setTreasury().accounts({ config: configPda, authority: authority.publicKey, treasury: treasury.publicKey } as any).rpc();
    });
    it("the authority moves in two steps: only the proposed key may accept, and the old one is then refused", async () => {
      await program.methods.proposeAuthority(stranger.publicKey).accounts({ config: configPda, authority: authority.publicKey } as any).rpc();
      await fails(program.methods.acceptAuthority().accounts({ config: configPda, newAuthority: nfi.publicKey } as any).signers([nfi]).rpc(), "NotAuthority");
      await program.methods.acceptAuthority().accounts({ config: configPda, newAuthority: stranger.publicKey } as any).signers([stranger]).rpc();
      await fails(program.methods.proposeAuthority(null).accounts({ config: configPda, authority: authority.publicKey } as any).rpc(), "NotAuthority");
      await program.methods.proposeAuthority(authority.publicKey).accounts({ config: configPda, authority: stranger.publicKey } as any).signers([stranger]).rpc();
      await program.methods.acceptAuthority().accounts({ config: configPda, newAuthority: authority.publicKey } as any).rpc();
      expect((await program.account.config.fetch(configPda)).authority.toBase58()).to.equal(authority.publicKey.toBase58());
    });
  });

  describe("init", () => {
    it("refuses bad windows, groups and phases", async () => {
      const m = await buildMachine({ items: 2 });
      await fails(initEscrow(m, now() + 1), "BadWindow");
      await fails(initEscrow(m, now() + 91 * 86400), "BadWindow");
      await fails(initEscrow(m, now() + 60, { gs: [] }), "BadGroups");
      await fails(initEscrow(m, now() + 60, { gs: Array.from({ length: 9 }, (_, i) => grp("g" + i, 1, 0)) }), "BadGroups");
      await fails(initEscrow(m, now() + 60, { gs: [grp("wl", 1, 0), grp("wl", 2, 0)] }), "BadGroups");
      await fails(initEscrow(m, now() + 60, { gs: [{ ...grp("x", 1, 0), label: [119, 108, 0, 120, 0, 0] }] }), "BadGroups");
      await fails(initEscrow(m, now() + 60, { gs: [grp("late", 1, 0, { start: now() + 120 })] }), "BadPhase");
      await fails(initEscrow(m, now() + 60, { gs: [grp("long", 1, 0, { end: now() + 120 })] }), "BadPhase");
      await fails(initEscrow(m, now() + 60, { gs: [grp("back", 1, 0, { start: now() + 30, end: now() + 20 })] }), "BadPhase");
    });
    it("the payout signs and is a funded plain wallet (L-012, L-036)", async () => {
      const m = await buildMachine({ items: 2 });
      await fails(initEscrow(m, now() + 60, { payout: Keypair.generate() }), "WalletUnfunded");
      const prog = await program.methods.init({ windowEnd: new BN(now() + 60), groups: groups(), permit: permit.publicKey, revealRoot: ZERO32 })
        .accounts({ config: configPda, escrow: pdas(m.cm).escrow, vault: pdas(m.cm).vault, candyMachine: m.cm, collection: m.collection, payout: payout.publicKey, creator: creator.publicKey, nfiAuthority: nfi.publicKey, candyMachineProgram: CANDY_MACHINE, mplCoreProgram: CORE, systemProgram: SystemProgram.programId } as any)
        .signers([creator, nfi]).instruction().catch((e) => e);
      expect(prog).to.not.be.instanceOf(Error); // the instruction builds; sending it without the payout's signature fails
      await fails(provider.sendAndConfirm(new Transaction().add(prog as any), [creator, nfi]), "ignature");
      const own = await initEscrow(m, now() + 60, { payout: creator }); // the creator's own wallet signs once for both
      expect((await program.account.launchEscrow.fetch(own.escrow)).payout.toBase58()).to.equal(creator.publicKey.toBase58());
    });
    it("refuses a collection that is not the creator's, a machine of another collection, and a non-machine", async () => {
      const m2 = await buildMachine({ items: 1 });
      await updateCollectionV1(umiCreator, { collection: pk(m2.collection), newUpdateAuthority: pk(stranger.publicKey), newName: none(), newUri: none() }).sendAndConfirm(umiCreator);
      await fails(initEscrow(m2, now() + 60), "CollectionNotCreators");
      const m3 = await buildMachine({ items: 1 }), m4 = await buildMachine({ items: 1 });
      await fails(initEscrow(m3, now() + 60, { machine: m4.cm }), "BadMachine");
      await fails(initEscrow(m3, now() + 60, { machine: configPda }), "BadMachine");
    });
    it("refuses permanent delegates, adapters, AddBlocker, a kept update delegate and creator-held plugin authorities (L-014)", async () => {
      const royalties = { type: "Royalties", basisPoints: 500, creators: [{ address: pk(payout.publicKey), percentage: 100 }], ruleSet: { type: "None" } };
      for (const plugin of [{ type: "PermanentFreezeDelegate", frozen: false }, { type: "PermanentTransferDelegate" }, { type: "PermanentBurnDelegate" },
        { type: "Oracle", resultsOffset: { type: "Anchor" }, baseAddress: pk(Keypair.generate().publicKey), lifecycleChecks: { burn: [CheckResult.CAN_REJECT] } },
        { ...royalties, authority: { type: "Address", address: pk(creator.publicKey) } }]) {
        const mx = await buildMachine({ items: 1, plugins: [plugin] });
        await fails(initEscrow(mx, now() + 60), "CollectionPluginRefused");
      }
      const blocked = await buildMachine({ items: 1, after: async (mx) => { await addCollectionPlugin(umiCreator, { collection: pk(mx.collection), plugin: { type: "AddBlocker" } }).sendAndConfirm(umiCreator); } });
      await fails(initEscrow(blocked, now() + 60), "CollectionPluginRefused");
      const extra = await buildMachine({ items: 1, after: async (mx) => {
        await updateCollectionPlugin(umiCreator, { collection: pk(mx.collection), plugin: { type: "UpdateDelegate", additionalDelegates: [pk(mx.authorityPda), pk(creator.publicKey)] } }).sendAndConfirm(umiCreator);
      } });
      await fails(initEscrow(extra, now() + 60), "CollectionPluginRefused");
      const kept = await buildMachine({ items: 1, after: async (mx) => {
        await approveCollectionPluginAuthority(umiCreator, { collection: pk(mx.collection), plugin: { type: "UpdateDelegate" }, newAuthority: { type: "Address", address: pk(creator.publicKey) } }).sendAndConfirm(umiCreator);
      } });
      await fails(initEscrow(kept, now() + 60), "CollectionPluginRefused");
      const ok = await buildMachine({ items: 1, plugins: [royalties, { type: "Attributes", attributeList: [{ key: "season", value: "1" }] }] });
      const L = await initEscrow(ok, now() + 60);
      expect(await collectionAuthority(ok)).to.equal(L.escrow.toBase58());
    });
    it("refuses a collection that already has an asset (L-004)", async () => {
      const m = await buildMachine({ items: 2 });
      await coreCreate(umiCreator, { asset: generateSigner(umiCreator), collection: await fetchCollection(umiCreator, pk(m.collection)), name: "pre", uri: "https://x.invalid/p.json" }).sendAndConfirm(umiCreator);
      await fails(initEscrow(m, now() + 60), "CollectionNotEmpty");
    });
    it("a hidden-settings machine needs a reveal commitment and a final-metadata machine must not have one (L-013)", async () => {
      const h = await buildMachine({ items: 2, hidden: true });
      await fails(initEscrow(h, now() + 60), "RevealCommitment");
      const c = await buildMachine({ items: 2 });
      await fails(initEscrow(c, now() + 60, { root: Array.from(Buffer.alloc(32, 7)) }), "RevealCommitment");
    });
    it("the squat: only NFI's configured hot key co-signs; the escrow then holds the machine and the collection", async () => {
      const m = await buildMachine({ items: 2 });
      await fails(initEscrow(m, now() + 60, { nfiSigner: stranger }), "NotNfi");
      const L = await initEscrow(m, now() + 60);
      const cm = await fetchCandyMachine(umiCreator, pk(m.cm));
      expect(cm.authority.toString()).to.equal(L.escrow.toBase58());
      expect(cm.mintAuthority.toString()).to.equal(L.escrow.toBase58());
      expect(await collectionAuthority(m)).to.equal(L.escrow.toBase58());
    });
  });

  describe("minting: pay_and_mint is the only way (L-001, L-002)", () => {
    let L: L;
    before(async () => { L = await initEscrow(await buildMachine({ items: 10 }), now() + 3600, { gs: [grp("wl", 0.5, 0.01, { perWallet: 1 }), grp("pub", 1, 0.02, { allocation: 3 }), grp("soon", 2, 0, { start: now() + 3000 })] }); });
    it("the honest mint pays exactly price plus fee into the vault, writes the receipt, and gives the minter a plugin-free asset", async () => {
      const v0 = await bal(L.vault);
      const a = await mint(L, minterA, 0);
      expect((await bal(L.vault)) - v0).to.equal(SOL(0.51).toNumber());
      const r = await program.account.mintReceipt.fetch(receiptPda(L.escrow, a));
      expect(r.minter.toBase58()).to.equal(minterA.publicKey.toBase58());
      expect(r.price.toString()).to.equal(SOL(0.5).toString());
      const asset = await fetchAsset(umiA, pk(a));
      expect(asset.owner.toString()).to.equal(minterA.publicKey.toBase58());
      expect(asset.freezeDelegate ?? asset.transferDelegate ?? asset.burnDelegate ?? asset.permanentTransferDelegate).to.equal(undefined);
      const e = await program.account.launchEscrow.fetch(L.escrow);
      expect(e.receipts.toNumber()).to.equal(1);
      expect(e.groups[0]!.minted).to.equal(1);
    });
    it("the guard can no longer mint, the machine refuses its creator, and the creator cannot take the mint authority back", async () => {
      await fails(mintV1(umiA, { candyMachine: pk(L.m.cm), candyGuard: pk(L.m.guard), collection: pk(L.m.collection), asset: generateSigner(umiA), group: none(), mintArgs: {} }).sendAndConfirm(umiA), "");
      await fails(mintAssetFromCandyMachine(umiCreator, { candyMachine: pk(L.m.cm), mintAuthority: umiCreator.identity, assetOwner: umiCreator.identity.publicKey, asset: generateSigner(umiCreator), collection: pk(L.m.collection) }).sendAndConfirm(umiCreator), "");
      await fails(setMintAuthority(umiCreator, { candyMachine: pk(L.m.cm), mintAuthority: umiCreator.identity }).sendAndConfirm(umiCreator), "");
      const e = await program.account.launchEscrow.fetch(L.escrow);
      const cm = await fetchCandyMachine(umiCreator, pk(L.m.cm));
      expect(Number(cm.itemsRedeemed)).to.equal(e.receipts.toNumber()); // every item minted has a receipt
    });
    it("a wrong or missing permit signature is refused; a rotated permit takes over at once", async () => {
      await fails(mint(L, minterB, 1, { permitSigner: stranger }), "NotPermit");
      const p2 = Keypair.generate();
      await fails(setPermit(L, p2.publicKey, stranger), "NotNfi");
      await setPermit(L, p2.publicKey);
      await fails(mint(L, minterB, 1), "NotPermit");
      await mint(L, minterB, 1, { permitSigner: p2 });
      await setPermit(L, permit.publicKey);
    });
    it("a pre-existing asset account cannot be minted into", async () => {
      const a = Keypair.generate();
      await provider.sendAndConfirm(new Transaction().add(SystemProgram.createAccount({ fromPubkey: minterB.publicKey, newAccountPubkey: a.publicKey, lamports: 10_000_000, space: 10, programId: CORE })), [minterB, a]).catch(() => undefined);
      await fails(mint(L, minterB, 1, { asset: a }), "");
    });
    it("phases: per-wallet limit, allocation, not-yet-started, unknown group", async () => {
      await fails(mint(L, minterA, 0), "WalletLimit");
      await mint(L, minterA, 1);
      await mint(L, minterA, 1);
      await fails(mint(L, minterB, 1), "PhaseSoldOut");
      await fails(mint(L, minterA, 2), "PhaseNotStarted");
      await fails(mint(L, minterA, 5), "BadGroup");
    });
    it("a phase change needs the creator and NFI, only before the phase starts, and never touches the price", async () => {
      await fails(setGroup(L, 1, now() + 100, 0, 0, 0), "PhaseStarted");
      await fails(setGroup(L, 2, now() + 100, 0, 0, 0, [stranger, creator]), "NotNfi");
      await fails(setGroup(L, 2, now() + 100, 0, 0, 0, [nfi, stranger]), "NotCreator");
      await fails(setGroup(L, 2, now() + 100, now() + 7200, 0, 0), "BadPhase");
      await setGroup(L, 2, now() + 2, 0, 5, 0);
      await sleep(4000);
      await mint(L, minterB, 2);
      const g = (await program.account.launchEscrow.fetch(L.escrow)).groups[2]!;
      expect(g.price.toString()).to.equal(SOL(2).toString());
      expect(g.perWallet).to.equal(5);
    });
    it("paused: minting stops; only the hot key pauses", async () => {
      await fails(setPaused(L, true, stranger), "NotNfi");
      await setPaused(L, true);
      await fails(mint(L, minterB, 2), "Paused");
      await setPaused(L, false);
    });
  });

  describe("cancel and refunds", () => {
    let L: L;
    let a1: PublicKey, a2: PublicKey, a3: PublicKey, a4: PublicKey;
    before(async () => {
      L = await initEscrow(await buildMachine({ items: 8 }), now() + 3600);
      a1 = await mint(L, minterA); a2 = await mint(L, minterA); a3 = await mint(L, minterB); a4 = await mint(L, minterB);
    });
    it("NFI's hot key cannot cancel (L-006); a stranger cannot; the canceller can", async () => {
      await fails(cancel(L, nfi), "NotCanceller");
      await fails(cancel(L, stranger), "NotCanceller");
      await cancel(L, canceller);
      await fails(cancel(L, creator), "NotOpen");
      await fails(mint(L, minterA), "NotOpen");
    });
    it("the owner burns and is paid in full; a stranger cannot; nor twice", async () => {
      await fails(refund(L, a1, minterA.publicKey, stranger), "NotOwner");
      const b0 = await bal(minterA.publicKey);
      await refund(L, a1, minterA.publicKey, minterA);
      expect((await bal(minterA.publicKey)) - b0).to.be.greaterThan(SOL(1.02).toNumber());
      await fails(refund(L, a1, minterA.publicKey, minterA), "AccountNotInitialized");
    });
    it("after a transfer the new owner refunds; a frozen asset waits for its thaw", async () => {
      await coreTransfer(umiA, { asset: await fetchAsset(umiA, pk(a2)), collection: await fetchCollection(umiA, pk(L.m.collection)), newOwner: pk(minterB.publicKey) }).sendAndConfirm(umiA);
      await addPlugin(umiB, { asset: pk(a2), collection: pk(L.m.collection), plugin: { type: "FreezeDelegate", frozen: true } }).sendAndConfirm(umiB);
      await fails(refund(L, a2, minterA.publicKey, minterB), "");
      await updatePlugin(umiB, { asset: pk(a2), collection: pk(L.m.collection), plugin: { type: "FreezeDelegate", frozen: false } }).sendAndConfirm(umiB);
      const b0 = await bal(minterB.publicKey);
      await refund(L, a2, minterA.publicKey, minterB);
      expect((await bal(minterB.publicKey)) - b0).to.be.greaterThan(SOL(1).toNumber());
    });
    it("burned outside refund, then swept by Core's Collect: anyone cranks and the minter is paid (L-005)", async () => {
      await coreBurn(umiB, { asset: await fetchAsset(umiB, pk(a3)), collection: await fetchCollection(umiB, pk(L.m.collection)) }).sendAndConfirm(umiB);
      await collect(umiCreator, {}).addRemainingAccounts({ pubkey: pk(a3), isSigner: false, isWritable: true }).sendAndConfirm(umiCreator);
      const info = await conn.getAccountInfo(a3, "confirmed");
      expect(info === null || info.owner.equals(SystemProgram.programId), "Collect reassigned the shell").to.equal(true);
      const b0 = await bal(minterB.publicKey);
      await refund(L, a3, minterB.publicKey, stranger);
      expect((await bal(minterB.publicKey)) - b0).to.be.greaterThan(SOL(1).toNumber());
    });
    it("one unclaimed receipt holds the collection only until the grace ends (L-011); its refund stays claimable after", async () => {
      await fails(returnCollection(L), "NotFinal");
      const e = await program.account.launchEscrow.fetch(L.escrow);
      await waitUntil(e.cancelledAt.toNumber() + 6);
      await returnCollection(L);
      expect(await collectionAuthority(L.m)).to.equal(creator.publicKey.toBase58());
      expect((await fetchCandyMachine(umiCreator, pk(L.m.cm))).authority.toString()).to.equal(creator.publicKey.toBase58());
      await fails(returnCollection(L), "CollectionReturned");
      const b0 = await bal(minterB.publicKey);
      await refund(L, a4, minterB.publicKey, minterB);
      expect((await bal(minterB.publicKey)) - b0).to.be.greaterThan(SOL(1).toNumber());
      await closeCounter(L, minterA.publicKey, 1);
      await closeEscrow(L);
    });
  });

  describe("release", () => {
    it("nothing before the window ends; then the payout, then the fee, once each; then everything closes", async () => {
      const L = await initEscrow(await buildMachine({ items: 4 }), now() + 8);
      const a = await mint(L, minterA);
      await fails(release(L), "WindowNotOver");
      await fails(cancel(L, stranger), "NotCanceller");
      await waitUntil((await program.account.launchEscrow.fetch(L.escrow)).windowEnd.toNumber());
      await fails(mint(L, minterA), "WindowOver");
      await fails(cancel(L, canceller), "WindowOver");
      await fails(releaseFee(L), "NotReleased");
      await fails(release(L, stranger, stranger.publicKey), "ConstraintHasOne");
      const p0 = await bal(payout.publicKey), t0 = await bal(treasury.publicKey);
      await release(L);
      expect((await bal(payout.publicKey)) - p0).to.equal(SOL(1).toNumber());
      await fails(release(L), "NotOpen");
      await releaseFee(L);
      expect((await bal(treasury.publicKey)) - t0).to.equal(SOL(0.02).toNumber());
      await fails(releaseFee(L), "AlreadyReleased");
      await fails(refund(L, a, minterA.publicKey, minterA), "NotCancelled");
      await fails(closeEscrow(L), "ReceiptsOpen");
      await closeReceipt(L, a, minterA.publicKey);
      await fails(closeEscrow(L), "NotFinal"); // the collection is not back yet
      await returnCollection(L);
      await closeCounter(L, minterA.publicKey, 1);
      await closeEscrow(L);
    });
  });

  describe("reveal (L-013, L-025)", () => {
    const items = 3;
    const finals = Array.from({ length: items }, (_, i) => ({ name: `Item #${i}`, uri: `https://launch.nfinn.io/spike/${(i % 5) + 1}.json` }));
    const tree = revealTree(finals.map((f, i) => revealLeaf(i, f.name, f.uri)));
    let L: L;
    const assets: PublicKey[] = [];
    before(async () => { L = await initEscrow(await buildMachine({ items, hidden: true }), now() + 30, { root: Array.from(tree.root) }); });
    it("waits until minting is over, then takes only the committed metadata, once per asset", async () => {
      assets.push(await mint(L, minterA));
      const r0 = await program.account.mintReceipt.fetch(receiptPda(L.escrow, assets[0]!));
      const i0 = r0.mintIndex.toNumber();
      await fails(reveal(L, assets[0]!, finals[i0]!.name, finals[i0]!.uri, tree.proofs[i0]!), "MintingNotOver");
      assets.push(await mint(L, minterA), await mint(L, minterB)); // sold out
      for (const a of assets) {
        const i = (await program.account.mintReceipt.fetch(receiptPda(L.escrow, a))).mintIndex.toNumber();
        const j = (i + 1) % items;
        await fails(reveal(L, a, finals[j]!.name, finals[j]!.uri, tree.proofs[j]!), "BadRevealProof"); // another item's metadata
        await fails(reveal(L, a, finals[i]!.name, "https://x.invalid/rug.json", tree.proofs[i]!), "BadRevealProof");
      }
      await reveal(L, assets[0]!, finals[i0]!.name, finals[i0]!.uri, tree.proofs[i0]!);
      expect((await fetchAsset(umiA, pk(assets[0]!))).uri).to.equal(finals[i0]!.uri);
      await fails(reveal(L, assets[0]!, finals[i0]!.name, finals[i0]!.uri, tree.proofs[i0]!), "AlreadyRevealed");
    });
    it("receipts and the collection wait for the reveal; every revealed asset is locked for good, even after the collection goes back", async () => {
      await waitUntil((await program.account.launchEscrow.fetch(L.escrow)).windowEnd.toNumber());
      await release(L);
      await fails(closeReceipt(L, assets[1]!, minterA.publicKey), "RevealPending");
      await fails(returnCollection(L), "NotFinal");
      for (const a of assets.slice(1)) {
        const i = (await program.account.mintReceipt.fetch(receiptPda(L.escrow, a))).mintIndex.toNumber();
        await reveal(L, a, finals[i]!.name, finals[i]!.uri, tree.proofs[i]!);
      }
      await returnCollection(L);
      expect(await collectionAuthority(L.m)).to.equal(creator.publicKey.toBase58());
      for (const a of assets) expect((await fetchAsset(umiA, pk(a))).immutableMetadata, "each revealed asset is locked").to.not.equal(undefined);
      // The creator holds the collection again, and still cannot touch a revealed asset's metadata.
      await fails(coreUpdate(umiCreator, { asset: await fetchAsset(umiCreator, pk(assets[0]!)), collection: await fetchCollection(umiCreator, pk(L.m.collection)), uri: "https://x.invalid/rug.json" }).sendAndConfirm(umiCreator), "");
      expect((await fetchAsset(umiA, pk(assets[0]!))).uri).to.not.equal("https://x.invalid/rug.json");
    });
  });

  describe("value conservation", () => {
    it("the vault holds exactly the liabilities plus its rent after every step of a mixed life", async () => {
      const L = await initEscrow(await buildMachine({ items: 6 }), now() + 3600);
      const rent = await conn.getMinimumBalanceForRentExemption(8 + 1);
      const check = async () => {
        const e = await program.account.launchEscrow.fetch(L.escrow);
        const owed = e.priceIn.add(e.feeIn).sub(e.priceRefunded).sub(e.feeRefunded).toNumber();
        expect(await bal(L.vault)).to.equal(rent + owed);
      };
      const as = [await mint(L, minterA, 0), await mint(L, minterB, 1), await mint(L, minterA, 1)];
      await check();
      await cancel(L, creator);
      await refund(L, as[0]!, minterA.publicKey, minterA); await check();
      await refund(L, as[1]!, minterB.publicKey, minterB); await check();
      await refund(L, as[2]!, minterA.publicKey, minterA); await check();
      expect(await bal(L.vault)).to.equal(rent);
      await returnCollection(L);
      await closeEscrow(L);
    });
  });
});
