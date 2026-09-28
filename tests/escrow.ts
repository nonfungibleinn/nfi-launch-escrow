// nfi_launch_escrow on a local validator, built with --features test (a 5 s minimum window). The happy path and
// every attack the design lists: wrong amounts, double pay, paused, late pay, early release, wrong-party cancel,
// refund without the burn, refund of someone else's mint, an asset from another collection, double refund, release
// after cancel, cancel after release, closing with receipts open, the crank paths.
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { generateSigner, keypairIdentity, publicKey as umiPk } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { burn as coreBurn, create as createCoreAsset, createCollection as createCoreCollection, fetchAsset, mplCore } from "@metaplex-foundation/mpl-core";
import { expect } from "chai";
import type { NfiLaunchEscrow } from "../target/types/nfi_launch_escrow";

const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
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
  const creator = Keypair.generate();
  const nfi = Keypair.generate();
  const minterA = Keypair.generate();
  const minterB = Keypair.generate();
  const stranger = Keypair.generate();
  const payout = Keypair.generate();
  const treasury = Keypair.generate();
  const airdrop = async (pk: PublicKey, sol = 10) => { const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction(sig, "confirmed"); };
  const bal = (pk: PublicKey) => conn.getBalance(pk, "confirmed");
  const pdas = (cm: PublicKey) => {
    const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("launch"), cm.toBuffer()], program.programId);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), escrow.toBuffer()], program.programId);
    return { escrow, vault };
  };
  const receiptPda = (escrow: PublicKey, asset: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("receipt"), escrow.toBuffer(), asset.toBuffer()], program.programId)[0];
  const fails = async (p: Promise<unknown>, needle: string) => { try { await p; } catch (e: any) { const m = String(e.message ?? e) + JSON.stringify(e.logs ?? []); expect(m, `expected "${needle}" in: ${m.slice(0, 300)}`).to.include(needle); return; } expect.fail(`expected failure: ${needle}`); };

  // Core: a collection the creator owns, and assets minted straight to a minter (what the candy machine would do).
  const umi = createUmi(conn.rpcEndpoint).use(mplCore());
  umi.use(keypairIdentity(fromWeb3JsKeypair(creator)));
  let collection: PublicKey;
  let otherCollection: PublicKey;
  const mintAsset = async (coll: PublicKey, owner: PublicKey): Promise<{ key: PublicKey; signer: ReturnType<typeof generateSigner> }> => {
    const asset = generateSigner(umi);
    const c = await (await import("@metaplex-foundation/mpl-core")).fetchCollection(umi, umiPk(coll.toBase58()));
    await createCoreAsset(umi, { asset, collection: c, name: "Escrow test", uri: "https://launch.nfinn.io/spike/1.json", owner: umiPk(owner.toBase58()) }).sendAndConfirm(umi);
    return { key: toWeb3JsPublicKey(asset.publicKey), signer: asset };
  };
  const now = () => Math.floor(Date.now() / 1000);
  const groups = [{ label: label("wl"), price: SOL(0.5), fee: SOL(0.01) }, { label: label("pub"), price: SOL(1), fee: SOL(0.02) }];
  const initEscrow = async (cm: PublicKey, windowEnd: number, opts: { nfiSigner?: Keypair; coll?: PublicKey; gs?: typeof groups } = {}) => {
    const { escrow, vault } = pdas(cm);
    await program.methods.init({ payout: payout.publicKey, treasury: treasury.publicKey, candyGuard: Keypair.generate().publicKey, collection: opts.coll ?? collection, windowEnd: new BN(windowEnd), groups: opts.gs ?? groups })
      .accounts({ escrow, vault, candyMachine: cm, creator: creator.publicKey, nfiAuthority: (opts.nfiSigner ?? nfi).publicKey, systemProgram: SystemProgram.programId })
      .signers([creator, opts.nfiSigner ?? nfi]).rpc();
    return { escrow, vault };
  };
  const pay = (escrow: PublicKey, vault: PublicKey, asset: PublicKey, minter: Keypair, group: number, amount: BN) =>
    program.methods.pay(group, amount).accounts({ escrow, vault, receipt: receiptPda(escrow, asset), asset, minter: minter.publicKey, systemProgram: SystemProgram.programId }).signers([minter]).rpc();
  const refund = (escrow: PublicKey, vault: PublicKey, asset: PublicKey, minter: PublicKey, signer: Keypair, coll = collection) =>
    program.methods.refund().accounts({ escrow, vault, receipt: receiptPda(escrow, asset), minter, asset, collection: coll, signer: signer.publicKey, mplCoreProgram: CORE, systemProgram: SystemProgram.programId }).signers([signer]).rpc();
  const release = (escrow: PublicKey, vault: PublicKey, signer: Keypair) =>
    program.methods.release().accounts({ escrow, vault, payout: payout.publicKey, treasury: treasury.publicKey, signer: signer.publicKey }).signers([signer]).rpc();

  before(async () => {
    await Promise.all([airdrop(creator.publicKey, 20), airdrop(nfi.publicKey, 2), airdrop(minterA.publicKey), airdrop(minterB.publicKey), airdrop(stranger.publicKey, 2), airdrop(payout.publicKey, 1), airdrop(treasury.publicKey, 1)]);
    const c1 = generateSigner(umi), c2 = generateSigner(umi);
    await createCoreCollection(umi, { collection: c1, name: "Launch", uri: "https://launch.nfinn.io/spike/1.json" }).sendAndConfirm(umi);
    await createCoreCollection(umi, { collection: c2, name: "Other", uri: "https://launch.nfinn.io/spike/1.json" }).sendAndConfirm(umi);
    collection = toWeb3JsPublicKey(c1.publicKey);
    otherCollection = toWeb3JsPublicKey(c2.publicKey);
  });

  describe("init", () => {
    it("refuses a window that is too short, too long, no groups, duplicate labels", async () => {
      const cm = Keypair.generate().publicKey;
      await fails(initEscrow(cm, now() + 1), "BadWindow");
      await fails(initEscrow(cm, now() + 91 * 86400), "BadWindow");
      await fails(initEscrow(cm, now() + 60, { gs: [] }), "BadGroups");
      await fails(initEscrow(cm, now() + 60, { gs: [groups[0], groups[0]] }), "BadGroups");
    });
    it("needs NFI's signature: a creator cannot bring their own", async () => {
      const cm = Keypair.generate().publicKey;
      const { escrow } = await initEscrow(cm, now() + 60, { nfiSigner: stranger });
      const e = await program.account.launchEscrow.fetch(escrow);
      // The program cannot know which key is NFI; the service refuses to approve an escrow whose nfi_authority is not its own.
      expect(e.nfiAuthority.toBase58()).to.equal(stranger.publicKey.toBase58());
    });
  });

  describe("the happy path: pay, window ends, anyone releases", () => {
    const cm = Keypair.generate().publicKey;
    let escrow: PublicKey, vault: PublicKey;
    let a1: PublicKey, a2: PublicKey;
    it("pays into the vault with a receipt per asset", async () => {
      ({ escrow, vault } = await initEscrow(cm, now() + 8));
      a1 = Keypair.generate().publicKey; a2 = Keypair.generate().publicKey;
      const v0 = await bal(vault);
      await pay(escrow, vault, a1, minterA, 0, SOL(0.51));
      await pay(escrow, vault, a2, minterB, 1, SOL(1.02));
      expect((await bal(vault)) - v0).to.equal(SOL(1.53).toNumber());
      const e = await program.account.launchEscrow.fetch(escrow);
      expect(e.priceIn.toString()).to.equal(SOL(1.5).toString());
      expect(e.feeIn.toString()).to.equal(SOL(0.03).toString());
      expect(e.receipts.toNumber()).to.equal(2);
      const r = await program.account.mintReceipt.fetch(receiptPda(escrow, a1));
      expect(r.minter.toBase58()).to.equal(minterA.publicKey.toBase58());
      expect(r.price.toString()).to.equal(SOL(0.5).toString());
    });
    it("refuses a wrong amount, a second payment for the same asset, an unknown group", async () => {
      await fails(pay(escrow, vault, Keypair.generate().publicKey, minterA, 0, SOL(0.5)), "BadAmount");
      await fails(pay(escrow, vault, a1, minterA, 0, SOL(0.51)), "already in use");
      await fails(pay(escrow, vault, Keypair.generate().publicKey, minterA, 5, SOL(0.51)), "BadGroup");
    });
    it("paused blocks pay and only NFI may pause", async () => {
      await fails(program.methods.setPaused(true).accounts({ escrow, nfiAuthority: creator.publicKey }).signers([creator]).rpc(), "NotNfi");
      await program.methods.setPaused(true).accounts({ escrow, nfiAuthority: nfi.publicKey }).signers([nfi]).rpc();
      await fails(pay(escrow, vault, Keypair.generate().publicKey, minterA, 0, SOL(0.51)), "Paused");
      await program.methods.setPaused(false).accounts({ escrow, nfiAuthority: nfi.publicKey }).signers([nfi]).rpc();
    });
    it("refuses a release before the window ends, then anyone releases and the split is exact", async () => {
      await fails(release(escrow, vault, stranger), "WindowNotOver");
      await sleep(9000);
      await fails(pay(escrow, vault, Keypair.generate().publicKey, minterA, 0, SOL(0.51)), "WindowOver");
      const p0 = await bal(payout.publicKey), t0 = await bal(treasury.publicKey);
      await release(escrow, vault, stranger);
      expect((await bal(payout.publicKey)) - p0).to.equal(SOL(1.5).toNumber());
      expect((await bal(treasury.publicKey)) - t0).to.equal(SOL(0.03).toNumber());
      const e = await program.account.launchEscrow.fetch(escrow);
      expect(JSON.stringify(e.status)).to.include("released");
      await fails(release(escrow, vault, stranger), "NotOpen");
      await fails(program.methods.cancel().accounts({ escrow, signer: nfi.publicKey }).signers([nfi]).rpc(), "NotOpen");
      await fails(refund(escrow, vault, a1, minterA.publicKey, minterA), "NotCancelled");
    });
    it("receipts close to their minters, then the creator closes the escrow and gets the rent", async () => {
      await fails(program.methods.closeEscrow().accounts({ escrow, vault, creator: creator.publicKey }).signers([creator]).rpc(), "ReceiptsOpen");
      const m0 = await bal(minterA.publicKey);
      await program.methods.closeReceipt().accounts({ escrow, receipt: receiptPda(escrow, a1), minter: minterA.publicKey, signer: stranger.publicKey }).signers([stranger]).rpc();
      expect(await bal(minterA.publicKey)).to.be.greaterThan(m0);
      await program.methods.closeReceipt().accounts({ escrow, receipt: receiptPda(escrow, a2), minter: minterB.publicKey, signer: stranger.publicKey }).signers([stranger]).rpc();
      await fails(program.methods.closeEscrow().accounts({ escrow, vault, creator: stranger.publicKey }).signers([stranger]).rpc(), "NotCreator");
      const c0 = await bal(creator.publicKey);
      await program.methods.closeEscrow().accounts({ escrow, vault, creator: creator.publicKey }).signers([creator]).rpc();
      expect(await bal(creator.publicKey)).to.be.greaterThan(c0);
      expect(await conn.getAccountInfo(escrow)).to.equal(null);
      expect(await conn.getAccountInfo(vault)).to.equal(null);
    });
  });

  describe("the cancelled path: refunds burn the asset and never expire", () => {
    const cm = Keypair.generate().publicKey;
    let escrow: PublicKey, vault: PublicKey;
    let assetA: { key: PublicKey }, assetB: { key: PublicKey }, foreign: { key: PublicKey };
    it("pays for real Core assets, then a stranger cannot cancel but the creator can", async () => {
      ({ escrow, vault } = await initEscrow(cm, now() + 3600));
      assetA = await mintAsset(collection, minterA.publicKey);
      assetB = await mintAsset(collection, minterB.publicKey);
      foreign = await mintAsset(otherCollection, minterA.publicKey);
      await pay(escrow, vault, assetA.key, minterA, 0, SOL(0.51));
      await pay(escrow, vault, assetB.key, minterB, 1, SOL(1.02));
      await pay(escrow, vault, foreign.key, minterA, 0, SOL(0.51));
      await fails(program.methods.cancel().accounts({ escrow, signer: stranger.publicKey }).signers([stranger]).rpc(), "NotNfi");
      await program.methods.cancel().accounts({ escrow, signer: creator.publicKey }).signers([creator]).rpc();
      const e = await program.account.launchEscrow.fetch(escrow);
      expect(JSON.stringify(e.status)).to.include("cancelled");
      expect(JSON.stringify(e.cancelledBy)).to.include("creator");
      await fails(pay(escrow, vault, Keypair.generate().publicKey, minterA, 0, SOL(0.51)), "NotOpen");
      await fails(release(escrow, vault, stranger), "NotOpen");
    });
    it("a stranger cannot refund someone's mint while the asset exists; the minter can, and the asset burns", async () => {
      await fails(refund(escrow, vault, assetA.key, minterA.publicKey, stranger), "NotMinter");
      const m0 = await bal(minterA.publicKey);
      await refund(escrow, vault, assetA.key, minterA.publicKey, minterA);
      const m1 = await bal(minterA.publicKey);
      expect(m1 - m0).to.be.greaterThan(SOL(0.5).toNumber()); // price + fee + receipt rent, minus the network fee
      expect(await conn.getAccountInfo(assetA.key)).to.equal(null);
      await fails(refund(escrow, vault, assetA.key, minterA.publicKey, minterA), "AccountNotInitialized");
    });
    it("an asset from another collection cannot be refunded here", async () => {
      await fails(refund(escrow, vault, foreign.key, minterA.publicKey, minterA), "AssetNotInCollection");
    });
    it("once the owner burned the asset themselves, anyone may crank the refund to the minter", async () => {
      const umiB = createUmi(conn.rpcEndpoint).use(mplCore()).use(keypairIdentity(fromWeb3JsKeypair(minterB)));
      const c = await (await import("@metaplex-foundation/mpl-core")).fetchCollection(umiB, umiPk(collection.toBase58()));
      const asset = await fetchAsset(umiB, umiPk(assetB.key.toBase58()));
      await coreBurn(umiB, { asset, collection: c }).sendAndConfirm(umiB);
      expect(await conn.getAccountInfo(assetB.key)).to.equal(null);
      const b0 = await bal(minterB.publicKey);
      await refund(escrow, vault, assetB.key, minterB.publicKey, stranger);
      expect((await bal(minterB.publicKey)) - b0).to.be.greaterThan(SOL(1.02).toNumber());
      const e = await program.account.launchEscrow.fetch(escrow);
      expect(e.priceRefunded.toString()).to.equal(SOL(1.5).toString());
      expect(e.feeRefunded.toString()).to.equal(SOL(0.03).toString());
      expect(e.receiptsOpen.toNumber()).to.equal(1); // the foreign asset's receipt is still open
    });
    it("the escrow cannot close while a receipt is unclaimed: refunds never expire", async () => {
      await fails(program.methods.closeEscrow().accounts({ escrow, vault, creator: creator.publicKey }).signers([creator]).rpc(), "ReceiptsOpen");
      // closing a receipt without a refund is only for released escrows
      await fails(program.methods.closeReceipt().accounts({ escrow, receipt: receiptPda(escrow, foreign.key), minter: minterA.publicKey, signer: stranger.publicKey }).signers([stranger]).rpc(), "NotFinal");
    });
    it("NFI can cancel a fresh escrow and the vault then only ever pays minters", async () => {
      const cm2 = Keypair.generate().publicKey;
      const { escrow: e2, vault: v2 } = await initEscrow(cm2, now() + 3600);
      const asset = await mintAsset(collection, minterA.publicKey);
      await pay(e2, v2, asset.key, minterA, 1, SOL(1.02));
      await program.methods.cancel().accounts({ escrow: e2, signer: nfi.publicKey }).signers([nfi]).rpc();
      const t0 = await bal(treasury.publicKey), p0 = await bal(payout.publicKey);
      await refund(e2, v2, asset.key, minterA.publicKey, minterA);
      expect(await bal(treasury.publicKey)).to.equal(t0);
      expect(await bal(payout.publicKey)).to.equal(p0);
      const c0 = await bal(creator.publicKey);
      await program.methods.closeEscrow().accounts({ escrow: e2, vault: v2, creator: creator.publicKey }).signers([creator]).rpc();
      expect(await bal(creator.publicKey)).to.be.greaterThan(c0);
    });
  });
});
