// Audit: a property / model test of nfi_launch_escrow (round-4 API) on a local validator, built with --features test
// (5 s minimum window, 6 s cancel and reveal grace). An off-chain model keeps every launch's escrow fields, phases, mint
// counters, receipts, vault lamports and liabilities; a seeded pseudo-random walk runs across up to three live launches
// (one plain config-line launch, one with per-wallet limits, allocations and future phases, one hidden-settings launch
// with a reveal commitment) and several wallets: pay_and_mint in valid and invalid phases/limits/permits/groups, Core
// transfers, self-burns and Collect on burned shells, refunds by the owner, a non-owner and a crank, cancel by the
// canceller / the creator / NFI's hot key / stale keys, pause, set_permit, set_group, release and release_fee (also
// fired together at the exact window deadline), reveal (right and wrong proofs, before and after minting ends),
// return_collection (incl. both grace paths), close_receipt, close_counter, close_escrow, direct mints that bypass the
// escrow, cross-launch account swaps, stray lamports, config rotations. After EVERY action:
//   - the model's prediction (success, or failure with one of the predicted errors) matches the chain, evaluated at
//     every clock value the transaction could have seen;
//   - the escrow's fields, phases, receipts and counters equal the model's; vault lamports equal the model's exactly;
//   - until release: vault == rent + price_in + fee_in - price_refunded - fee_refunded + stray, and the open receipts
//     sum to exactly that; after release: vault - rent >= what is still owed (the fee leg);
//   - the Candy Machine's items_redeemed == the escrow's receipts (no mint without a receipt), mint numbers distinct;
//   - exact balance deltas for every payee (payout, treasury, refund payee, crank, receipt and counter rent, close).
// Each seed ends by draining every launch (release or refund of every receipt, incl. refunds after a grace return,
// reveals, collection back, counters and receipts closed, escrow closed).
// Env: AUDIT_SEEDS (default 1,2,3,4), AUDIT_ACTIONS (per seed, default 3000), AUDIT_SEED_MINUTES (default 22; the walk stops at either, then drains).
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY, SYSVAR_CLOCK_PUBKEY, ComputeBudgetProgram, Transaction } from "@solana/web3.js";
import { createHash } from "crypto";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { generateSigner, keypairIdentity, publicKey as umiPk, some, none, type Umi } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { burn as coreBurn, collect, transfer as coreTransfer, createCollection as createCoreCollection, fetchAsset, fetchCollection, mplCore } from "@metaplex-foundation/mpl-core";
import { addConfigLines, create as createMachine, findCandyGuardPda, findCandyMachineAuthorityPda, mintAssetFromCandyMachine, mintV1, mplCandyMachine } from "@metaplex-foundation/mpl-core-candy-machine";
import { expect } from "chai";
import type { NfiLaunchEscrow } from "../target/types/nfi_launch_escrow";

const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const CANDY_MACHINE = new PublicKey("CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J");
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const SEEDS = (process.env.AUDIT_SEEDS ?? "1,2,3,4").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
const MAX_ACTIONS = Number(process.env.AUDIT_ACTIONS ?? 3000);
const MAX_MS = Number(process.env.AUDIT_SEED_MINUTES ?? 22) * 60_000;
const GRACE = 6; // CANCEL_GRACE_SECS and REVEAL_GRACE_SECS under the test feature
const LABELS = ["wl", "pub", "og"];
const PRICES: [number, number][] = [[0, 0], [100_000, 1_000], [1_000_000, 0], [0, 500_000], [50_000_000, 1_000_000], [300_000_000, 6_000_000]];
const CORE_FAIL = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d failed";
const CM_EMPTY = ["CandyMachineEmpty", "Candy machine is empty"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const label6 = (s: string) => { const b = Buffer.alloc(6); b.write(s); return Array.from(b); };
const ZERO32 = Array.from(Buffer.alloc(32));

// ---- the reveal commitment, exactly as the program hashes it (same as tests/escrow.ts) ----
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const sha = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const revealLeaf = (i: number, name: string, uri: string) => sha(Buffer.from([0]), u64(i), u32(Buffer.byteLength(name)), Buffer.from(name), u32(Buffer.byteLength(uri)), Buffer.from(uri));
const node = (a: Buffer, b: Buffer) => (Buffer.compare(a, b) <= 0 ? sha(Buffer.from([1]), a, b) : sha(Buffer.from([1]), b, a));
const revealTree = (leaves: Buffer[]) => {
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

function rngFrom(seed: number) {
  let a = seed >>> 0;
  const f = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { f, int: (n: number) => Math.floor(f() * n), pick: <T>(xs: T[]): T => xs[Math.floor(f() * xs.length)]!, chance: (p: number) => f() < p };
}

type W = { name: string; kp: Keypair; umi: Umi };
type Rec = { minter: W; price: number; fee: number; gi: number; open: boolean; refunded: boolean; mintIndex: number; revealed: boolean };
type Asset = { key: PublicKey; owner: W | null; state: "live" | "shell" | "collected"; rec: Rec };
type Grp = { label: string; price: number; fee: number; start: number; end: number; perWallet: number; allocation: number; minted: number };
type Counter = { w: W; gi: number; count: number; open: boolean };
type Kind = "plain" | "limits" | "reveal";
type Machine = { cm: PublicKey; guard: PublicKey; collection: PublicKey; authorityPda: PublicKey; hidden: boolean; items: number };
type Status = "open" | "cancelled" | "released" | "closed";
type Launch = {
  id: string; kind: Kind; m: Machine; creator: W; escrow: PublicKey; vault: PublicKey; payout: Keypair; treasury: PublicKey; windowEnd: number;
  groups: Grp[]; permit: Keypair; stalePermit: Keypair | null; finals: { name: string; uri: string }[]; tree: { root: Buffer; proofs: Buffer[][] } | null;
  status: Status; cancelledBy: string; cancelledAt: number; paused: boolean; feeReleased: boolean; collReturned: boolean;
  priceIn: number; feeIn: number; priceRefunded: number; feeRefunded: number; receipts: number; receiptsOpen: number; revealed: number;
  vaultLamports: number; escrowLamports: number; stray: number; assets: Asset[]; counters: Map<string, Counter>;
  log: string[]; tainted: boolean; burstDone: boolean; graceReturned: boolean;
  flow: { inPay: number; inStray: number; outPayout: number; outTreasury: number; outRefund: number; outCreator: number };
};

describe("audit: property test of the round-4 escrow", function () {
  this.timeout(0);
  const provider = anchor.AnchorProvider.env();
  (provider.opts as any).commitment = "confirmed";
  (provider.opts as any).preflightCommitment = "confirmed";
  anchor.setProvider(provider);
  const program = anchor.workspace.NfiLaunchEscrow as Program<NfiLaunchEscrow>;
  const conn = provider.connection;
  const authority = (provider.wallet as anchor.Wallet).payer;
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config2")], program.programId);
  const pdas = (cm: PublicKey) => {
    const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("launch"), cm.toBuffer()], program.programId);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), escrow.toBuffer()], program.programId);
    return { escrow, vault };
  };
  const receiptPda = (escrow: PublicKey, asset: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("receipt"), escrow.toBuffer(), asset.toBuffer()], program.programId)[0];
  const counterPda = (escrow: PublicKey, minter: PublicKey, g: number) => PublicKey.findProgramAddressSync([Buffer.from("minted"), escrow.toBuffer(), minter.toBuffer(), Buffer.from([g])], program.programId)[0];
  const umiFor = (kp: Keypair): Umi => createUmi(conn.rpcEndpoint, { commitment: "confirmed" }).use(mplCore()).use(mplCandyMachine()).use(keypairIdentity(fromWeb3JsKeypair(kp)));
  const mkW = (name: string): W => { const kp = Keypair.generate(); return { name, kp, umi: umiFor(kp) }; };
  const upk = (p: PublicKey) => umiPk(p.toBase58());
  const bal = (pk: PublicKey) => conn.getBalance(pk, "confirmed");
  const lamportsOf = async (pk: PublicKey) => (await conn.getAccountInfo(pk, "confirmed"))?.lamports ?? 0;
  const airdrop = async (pk: PublicKey, sol: number) => { const sig = await conn.requestAirdrop(pk, Math.round(sol * LAMPORTS_PER_SOL)); await conn.confirmTransaction(sig, "confirmed"); };
  const chainTime = async (c: "confirmed" | "processed") => { const a = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, c); return Number(a!.data.readBigInt64LE(32)); };
  const itemsRedeemed = async (cm: PublicKey) => { const a = await conn.getAccountInfo(cm, "confirmed"); return Number(a!.data.readBigUInt64LE(104)); };
  const cmAuthorities = async (cm: PublicKey) => { const a = await conn.getAccountInfo(cm, "confirmed"); return { authority: new PublicKey(a!.data.subarray(8, 40)), mintAuthority: new PublicKey(a!.data.subarray(40, 72)) }; };

  // ---- error decoding ----
  const errByCode: Record<number, string> = { 3012: "AccountNotInitialized", 2001: "ConstraintHasOne", 2006: "ConstraintSeeds", 2003: "ConstraintRaw", 3007: "AccountOwnedByWrongProgram", 2012: "ConstraintAddress" };
  for (const e of ((program.idl as any).errors ?? [])) errByCode[e.code] = e.name;
  const errText = (e: any) => {
    let m = String(e?.message ?? e) + " " + JSON.stringify(e?.logs ?? e?.transactionLogs ?? []) + " " + String(e?.cause ?? "");
    try { m += " " + JSON.stringify(e); } catch { /* circular */ }
    for (const mm of m.matchAll(/"Custom":(\d+)/g)) m += " " + (errByCode[Number(mm[1])] ?? "");
    for (const mm of m.matchAll(/custom program error: 0x([0-9a-f]+)/gi)) m += " " + (errByCode[parseInt(mm[1]!, 16)] ?? "");
    return m;
  };
  /** Anchor builder -> tx paid by the provider wallet (so no signer pays a network fee: payee deltas are exact), preflight,
   *  confirm, and THROW with the logs when it fails on chain after passing preflight. */
  const sendTx = async (tx: Transaction, signers: Keypair[]) => {
    tx.feePayer = authority.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(authority, ...signers.filter((k) => !k.publicKey.equals(authority.publicKey)));
    const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    const res = await conn.confirmTransaction(sig, "confirmed");
    if (res.value.err) {
      const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      throw new Error(`on-chain failure ${JSON.stringify(res.value.err)} ${JSON.stringify(t?.meta?.logMessages ?? [])}`);
    }
    return sig;
  };
  const send = async (mb: any, signers: Keypair[]) => sendTx(await mb.transaction(), signers);
  const usend = async (b: any, u: Umi) => {
    const { signature, result } = await b.sendAndConfirm(u);
    if (result.value.err) {
      const sig = anchor.utils.bytes.bs58.encode(Buffer.from(signature));
      const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      throw new Error(`on-chain failure ${JSON.stringify(result.value.err)} ${JSON.stringify(t?.meta?.logMessages ?? [])}`);
    }
  };
  const FLAKE = /Blockhash not found|block height exceeded|already been processed|ECONNREFUSED|socket hang up|Timeout|timed out|was not confirmed/i;

  // ---- global state ----
  let VAULT_RENT = 0;
  const nfiA = Keypair.generate(), nfiB = Keypair.generate(), cancA = Keypair.generate(), cancB = Keypair.generate();
  const tA = Keypair.generate(), tB = Keypair.generate();
  const cfg = { nfi: nfiA, oldNfi: nfiB, canceller: cancA, oldCanceller: cancB, treasury: tA.publicKey };
  const stranger = Keypair.generate(), cranker = Keypair.generate();
  let nonce = 0;
  const cu = (units = 600_000) => [ComputeBudgetProgram.setComputeUnitLimit({ units: units + (nonce++ % 100_000) })]; // unique txs

  type Summary = { seed: number; actions: number; ok: number; expectedFail: number; launches: number; kinds: Record<string, number>; ms: number; byType: Record<string, number>; okByType: Record<string, number>; failReasons: Record<string, number>; drainActions: number };
  const summaries: Summary[] = [];
  const violations: { seed: number; launch: string; what: string; seq: string[] }[] = [];
  const observations: Record<string, number> = {};
  const flakes: string[] = [];
  const observe = (k: string) => { observations[k] = (observations[k] ?? 0) + 1; };

  before(async () => {
    VAULT_RENT = await conn.getMinimumBalanceForRentExemption(8 + 1);
    // Core's Collect pays these two fixed fee recipients; on a fresh validator they must exist first.
    await Promise.all(["8AT6o8Qk5T9QnZvPThMrF9bcCQLTGkyGvVZZzHgCw11v", "MmHsqX4LxTfifxoH8BVRLUKrwDn1LPCac6YcCZTHhwt"].map((k) => airdrop(new PublicKey(k), 1)));
    await Promise.all([nfiA, nfiB, cancA, cancB, tA, tB].map((k) => airdrop(k.publicKey, 2)));
    await Promise.all([airdrop(stranger.publicKey, 50), airdrop(cranker.publicKey, 50)]);
    const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_LOADER_UPGRADEABLE);
    if (!(await conn.getAccountInfo(configPda, "confirmed"))) {
      await program.methods.initConfig(nfiA.publicKey, cancA.publicKey).accounts({ config: configPda, authority: authority.publicKey, program: program.programId, programData, treasury: tA.publicKey, systemProgram: SystemProgram.programId } as any).rpc();
    } else { // another suite created it: point it at this run's keys (all fresh, so no key equals another)
      await program.methods.setCanceller(cancA.publicKey).accounts({ config: configPda, authority: authority.publicKey } as any).rpc();
      await program.methods.setNfiAuthority(nfiA.publicKey).accounts({ config: configPda, authority: authority.publicKey } as any).rpc();
      await program.methods.setTreasury().accounts({ config: configPda, authority: authority.publicKey, treasury: tA.publicKey } as any).rpc();
    }
    const c = await program.account.config.fetch(configPda, "confirmed");
    expect(c.nfiAuthority.toBase58()).to.equal(nfiA.publicKey.toBase58());
    expect(c.canceller.toBase58()).to.equal(cancA.publicKey.toBase58());
  });

  const runSeed = async (seed: number) => {
    const rng = rngFrom(seed);
    const t0 = Date.now();
    const wallets: W[] = Array.from({ length: 5 }, (_, i) => mkW(`w${i}`));
    await Promise.all(wallets.map((w) => airdrop(w.kp.publicKey, 100)));
    const strangerW: W = { name: "stranger", kp: stranger, umi: umiFor(stranger) };
    const crankerW: W = { name: "cranker", kp: cranker, umi: umiFor(cranker) };
    const pool: Launch[] = [];
    let launchSeq = 0;
    const S: Summary = { seed, actions: 0, ok: 0, expectedFail: 0, launches: 0, kinds: {}, ms: 0, byType: {}, okByType: {}, failReasons: {}, drainActions: 0 };
    let draining = false;
    const adminLog: string[] = [];

    const violation = (L: Launch | null, what: string) => {
      const seq = L ? [...L.log] : [...adminLog];
      violations.push({ seed, launch: L?.id ?? "-", what, seq: seq.slice(-40) });
      console.log(`PROP VIOLATION seed=${seed} launch=${L?.id ?? "-"}: ${what}\n  seq(last 40): ${seq.slice(-40).join(" | ")}`);
      if (L) L.tainted = true;
    };

    // ---- the model ----
    const owedRefunds = (L: Launch) => L.assets.filter((a) => a.rec.open).reduce((s, a) => s + a.rec.price + a.rec.fee, 0);
    const liabilities = (L: Launch) => {
      if (L.status === "closed") return 0;
      if (L.status === "released") return L.feeReleased ? 0 : L.feeIn - L.feeRefunded;
      return (L.priceIn - L.priceRefunded) + (L.feeIn - L.feeRefunded);
    };
    const closes = (L: Launch, g: Grp) => (g.end === 0 ? L.windowEnd : g.end);
    const thresholds = (L: Launch) => {
      const t = [L.windowEnd, L.windowEnd + GRACE];
      if (L.status === "cancelled") t.push(L.cancelledAt + GRACE);
      for (const g of L.groups) t.push(g.start, closes(L, g));
      return t;
    };
    const ckey = (w: W, gi: number) => `${w.kp.publicKey.toBase58()}:${gi}`;
    const hasReveal = (L: Launch) => L.kind === "reveal";

    const checkInvariants = async (L: Launch) => {
      if (L.tainted) return;
      const e: any = await program.account.launchEscrow.fetchNullable(L.escrow, "confirmed");
      const v = await conn.getAccountInfo(L.vault, "confirmed");
      if (L.status === "closed") {
        if (e || (v && v.lamports > 0)) violation(L, "model says closed but escrow or vault still exists");
        return;
      }
      if (!e || !v) return violation(L, "escrow or vault missing while the model says " + L.status);
      const diffs: string[] = [];
      const cmp = (k: string, chain: any, model: any) => { if (String(chain) !== String(model)) diffs.push(`${k}: chain=${chain} model=${model}`); };
      cmp("status", Object.keys(e.status)[0]!.toLowerCase(), L.status); cmp("paused", e.paused, L.paused); cmp("feeReleased", e.feeReleased, L.feeReleased); cmp("collectionReturned", e.collectionReturned, L.collReturned);
      cmp("priceIn", e.priceIn.toString(), L.priceIn); cmp("feeIn", e.feeIn.toString(), L.feeIn); cmp("priceRefunded", e.priceRefunded.toString(), L.priceRefunded); cmp("feeRefunded", e.feeRefunded.toString(), L.feeRefunded);
      cmp("receipts", e.receipts.toString(), L.receipts); cmp("receiptsOpen", e.receiptsOpen.toString(), L.receiptsOpen); cmp("revealed", e.revealed.toString(), L.revealed);
      cmp("windowEnd", e.windowEnd.toString(), L.windowEnd); cmp("permit", e.permit.toBase58(), L.permit.publicKey.toBase58()); cmp("vaultLamports", v.lamports, L.vaultLamports);
      if (L.status === "cancelled") { cmp("cancelledBy", Object.keys(e.cancelledBy)[0]!.toLowerCase(), L.cancelledBy); cmp("cancelledAt", e.cancelledAt.toString(), L.cancelledAt); }
      L.groups.forEach((g, i) => {
        const c = e.groups[i];
        if (!c) { diffs.push(`group ${i} missing`); return; }
        cmp(`g${i}.start`, c.start.toString(), g.start); cmp(`g${i}.end`, c.end.toString(), g.end); cmp(`g${i}.perWallet`, c.perWallet, g.perWallet);
        cmp(`g${i}.allocation`, c.allocation, g.allocation); cmp(`g${i}.minted`, c.minted, g.minted); cmp(`g${i}.price`, c.price.toString(), g.price); cmp(`g${i}.fee`, c.fee.toString(), g.fee);
      });
      // value: exact until the release; covered after it
      const owed = (L.priceIn + L.feeIn) - (L.priceRefunded + L.feeRefunded);
      if (L.status !== "released") {
        if (v.lamports !== VAULT_RENT + owed + L.stray) diffs.push(`VAULT: ${v.lamports} != rent ${VAULT_RENT} + owed ${owed} + stray ${L.stray}`);
        if (owedRefunds(L) !== owed) diffs.push(`open receipts owe ${owedRefunds(L)} but the counters say ${owed}`);
      }
      if (v.lamports - VAULT_RENT < liabilities(L)) diffs.push(`UNDERFUNDED: vault-rent=${v.lamports - VAULT_RENT} < liabilities=${liabilities(L)}`);
      if (L.receiptsOpen !== L.assets.filter((a) => a.rec.open).length) diffs.push("receiptsOpen does not match the model's open receipts");
      // no mint without a receipt
      const redeemed = await itemsRedeemed(L.m.cm);
      if (redeemed !== Number(e.receipts.toString())) diffs.push(`MINT WITHOUT RECEIPT: items_redeemed=${redeemed} receipts=${e.receipts}`);
      const idx = L.assets.map((a) => a.rec.mintIndex);
      if (new Set(idx).size !== idx.length || idx.some((i) => i < 0 || i >= L.m.items)) diffs.push(`mint numbers not distinct or out of range: ${idx.join(",")}`);
      // receipts
      for (let i = 0; i < L.assets.length; i += 100) {
        const chunk = L.assets.slice(i, i + 100);
        const rs = await program.account.mintReceipt.fetchMultiple(chunk.map((a) => receiptPda(L.escrow, a.key)), "confirmed");
        chunk.forEach((a, j) => {
          const r: any = rs[j];
          if (a.rec.open !== !!r) diffs.push(`receipt ${a.key.toBase58().slice(0, 6)} open: chain=${!!r} model=${a.rec.open}`);
          if (r && (r.minter.toBase58() !== a.rec.minter.kp.publicKey.toBase58() || r.price.toNumber() !== a.rec.price || r.fee.toNumber() !== a.rec.fee || r.refunded
            || r.group !== a.rec.gi || r.mintIndex.toNumber() !== a.rec.mintIndex || r.revealed !== a.rec.revealed)) diffs.push(`receipt ${a.key.toBase58().slice(0, 6)} fields differ`);
        });
      }
      // counters
      const cs = [...L.counters.values()];
      if (cs.length) {
        const cc = await program.account.mintCounter.fetchMultiple(cs.map((c) => counterPda(L.escrow, c.w.kp.publicKey, c.gi)), "confirmed");
        cs.forEach((c, j) => {
          const x: any = cc[j];
          if (c.open !== !!x) diffs.push(`counter ${c.w.name}/g${c.gi} open: chain=${!!x} model=${c.open}`);
          if (x && x.count !== c.count) diffs.push(`counter ${c.w.name}/g${c.gi} count: chain=${x.count} model=${c.count}`);
        });
      }
      if (diffs.length) violation(L, "model/chain mismatch: " + diffs.join("; "));
    };
    const checkConfig = async () => {
      const c = await program.account.config.fetch(configPda, "confirmed");
      if (c.nfiAuthority.toBase58() !== cfg.nfi.publicKey.toBase58() || c.canceller.toBase58() !== cfg.canceller.publicKey.toBase58() || c.treasury.toBase58() !== cfg.treasury.toBase58() || c.authority.toBase58() !== authority.publicKey.toBase58())
        violation(null, "config differs from the model");
    };

    type Outcome = { ok: boolean; msg: string };
    const run = async (fn: () => Promise<any>): Promise<Outcome> => { try { await fn(); return { ok: true, msg: "" }; } catch (e: any) { return { ok: false, msg: errText(e) }; } };

    /** One action: run it; the model's reasons are evaluated at every clock value the transaction could have seen (the
     *  confirmed clock before it, each threshold crossed, the processed clock after); at least one must match. */
    const act = async (L: Launch | null, kind: string, desc: string, fn: () => Promise<any>, reasons: (t: number) => string[], o: { onOk?: (t: number) => Promise<void> | void; extraT?: number[] } = {}) => {
      S.actions++; if (draining) S.drainActions++;
      S.byType[kind] = (S.byType[kind] ?? 0) + 1;
      const full = `${kind}:${desc}`;
      if (L) L.log.push(full); else adminLog.push(full);
      const tb = await chainTime("confirmed");
      const out = await run(fn);
      const ta = await chainTime("processed");
      if (!out.ok && FLAKE.test(out.msg) && !/Error Code|custom program error|"Custom"/.test(out.msg)) {
        flakes.push(`${seed}/${L?.id}: ${full}: ${out.msg.slice(0, 160)}`);
        if (L) { L.tainted = true; console.log(`PROP FLAKE (launch ${L.id} retired from the run): ${out.msg.slice(0, 200)}`); }
        return false;
      }
      const th = [...(L && L.status !== "closed" ? thresholds(L) : []), ...(o.extraT ?? [])].filter((x) => x > tb && x <= ta);
      const cands = [...new Set([tb, ...th, ta])].sort((a, b) => a - b);
      const consistent = cands.filter((t) => { const r = reasons(t); return out.ok ? r.length === 0 : r.length > 0 && r.some((n) => out.msg.includes(n)); });
      if (!consistent.length) {
        violation(L, `${full}: expected ${cands.map((t) => `t=${t}:${JSON.stringify(reasons(t))}`).join(" or ")}, got ${out.ok ? "SUCCESS" : out.msg.slice(0, 400)}`);
        return out.ok;
      }
      if (out.ok) { S.okByType[kind] = (S.okByType[kind] ?? 0) + 1; }
      else { const hit = reasons(consistent[0]!).find((n) => n && out.msg.includes(n)) ?? "any"; const k2 = `${kind}:${hit.startsWith("CoRE") ? "CoreRefused" : hit}`; S.failReasons[k2] = (S.failReasons[k2] ?? 0) + 1; }
      if (out.ok) { S.ok++; if (o.onOk) { try { await o.onOk(consistent[0]!); } catch (e: any) { violation(L, `${full}: post-check failed: ${String(e?.message ?? e).slice(0, 300)}`); } } }
      else S.expectedFail++;
      if (L) await checkInvariants(L); else await checkConfig();
      return out.ok;
    };
    const need = (cond: boolean, what: string) => { if (!cond) throw new Error(what); };

    // ---- machines and launches ----
    const buildMachine = async (creator: W, items: number, hidden: boolean): Promise<Machine> => {
      const u = creator.umi;
      const coll = generateSigner(u);
      await usend(createCoreCollection(u, { collection: coll, name: "Prop", uri: "https://example.com/p/c.json" }), u);
      const cm = generateSigner(u);
      const b = await createMachine(u, {
        candyMachine: cm, collection: coll.publicKey, collectionUpdateAuthority: u.identity, itemsAvailable: items,
        configLineSettings: hidden ? none() : some({ prefixName: "P #", nameLength: 4, prefixUri: "https://example.com/p/", uriLength: 8, isSequential: false }),
        hiddenSettings: hidden ? some({ name: "Hidden #$ID$", uri: "https://example.com/p/hidden.json", hash: new Uint8Array(32) }) : none(),
        guards: {},
      });
      await usend(b, u);
      if (!hidden) for (let i = 0; i < items; i += 10) {
        const n = Math.min(10, items - i);
        await usend(addConfigLines(u, { candyMachine: cm.publicKey, index: i, configLines: Array.from({ length: n }, (_, k) => ({ name: String(i + k + 1), uri: `${i + k + 1}.json` })) }), u);
      }
      return {
        cm: toWeb3JsPublicKey(cm.publicKey), guard: toWeb3JsPublicKey(findCandyGuardPda(u, { base: cm.publicKey })[0]), collection: toWeb3JsPublicKey(coll.publicKey),
        authorityPda: toWeb3JsPublicKey(findCandyMachineAuthorityPda(u, { candyMachine: cm.publicKey })[0]), hidden, items,
      };
    };
    const collectionAuthority = async (L: Launch) => (await fetchCollection(L.creator.umi, upk(L.m.collection))).updateAuthority.toString();

    const KINDS: Kind[] = ["reveal", "limits", "plain"];
    const newLaunch = async (): Promise<Launch | null> => {
      const kind = KINDS[launchSeq % 3]!;
      const id = `L${++launchSeq}${kind[0]}`;
      const creator = mkW("creator");
      await airdrop(creator.kp.publicKey, 20);
      const items = kind === "reveal" ? 6 + rng.int(10) : kind === "limits" ? 14 + rng.int(10) : 10 + rng.int(14);
      const m = await buildMachine(creator, items, kind === "reveal");
      const { escrow, vault } = pdas(m.cm);
      const payout = Keypair.generate();
      await airdrop(payout.publicKey, 0.01);
      const permit = Keypair.generate();
      const finals = Array.from({ length: items }, (_, i) => ({ name: `Item #${i}`, uri: `https://example.com/r/${i}.json` }));
      const tree = kind === "reveal" ? revealTree(finals.map((f, i) => revealLeaf(i, f.name, f.uri))) : null;
      const now = await chainTime("processed");
      const W_ = 18 + rng.int(26);
      const windowEnd = now + W_;
      const pr = () => rng.pick(PRICES);
      let groups: Grp[];
      if (kind === "limits") {
        const [p0, f0] = pr(), [p1, f1] = pr(), [p2, f2] = pr();
        groups = [
          { label: "wl", price: p0, fee: f0, start: 0, end: now + Math.floor(W_ / 2), perWallet: 1 + rng.int(2), allocation: 0, minted: 0 },
          { label: "pub", price: p1, fee: f1, start: now + 4 + rng.int(Math.floor(W_ / 3)), end: 0, perWallet: 0, allocation: 2 + rng.int(5), minted: 0 },
          { label: "og", price: p2, fee: f2, start: now + Math.floor(W_ * 0.6), end: rng.chance(0.5) ? 0 : windowEnd - 2, perWallet: 2, allocation: rng.chance(0.5) ? 0 : 3, minted: 0 },
        ];
      } else {
        const labels = [...LABELS].sort(() => rng.f() - 0.5).slice(0, 1 + rng.int(kind === "reveal" ? 2 : 3));
        groups = labels.map((l) => { const [p, f] = pr(); return { label: l, price: p, fee: f, start: 0, end: 0, perWallet: kind === "reveal" && rng.chance(0.5) ? 3 : 0, allocation: 0, minted: 0 }; });
      }
      const rootArr = tree ? Array.from(tree.root) : ZERO32;
      const initWith = (nfiSigner: Keypair, root: number[], pay: Keypair) => () => send(program.methods.init({
        windowEnd: new BN(windowEnd), permit: permit.publicKey, revealRoot: root,
        groups: groups.map((g) => ({ label: label6(g.label), price: new BN(g.price), fee: new BN(g.fee), start: new BN(g.start), end: new BN(g.end), perWallet: g.perWallet, allocation: g.allocation })),
      }).accounts({ config: configPda, escrow, vault, candyMachine: m.cm, collection: m.collection, payout: pay.publicKey, creator: creator.kp.publicKey, nfiAuthority: nfiSigner.publicKey, candyMachineProgram: CANDY_MACHINE, mplCoreProgram: CORE, systemProgram: SystemProgram.programId } as any)
        .preInstructions(cu(400_000)), [creator.kp, nfiSigner, pay]);
      const k = rng.f();
      if (k < 0.08) await act(null, "init", `${id} by the stale NFI key`, initWith(cfg.oldNfi, rootArr, payout), () => ["NotNfi"]);
      else if (k < 0.14) await act(null, "init", `${id} with the wrong reveal commitment`, initWith(cfg.nfi, tree ? ZERO32 : Array.from(Buffer.alloc(32, 7)), payout), () => ["RevealCommitment"]);
      else if (k < 0.19) await act(null, "init", `${id} with an unfunded payout`, initWith(cfg.nfi, rootArr, Keypair.generate()), () => ["WalletUnfunded"]);
      let L: Launch | null = null;
      const treasury = cfg.treasury;
      await act(null, "init", `${id} ${kind} items=${items} window=${W_}s groups=${JSON.stringify(groups.map((g) => [g.label, g.price, g.fee, g.start ? g.start - now : 0, g.end ? g.end - now : 0, g.perWallet, g.allocation]))}`, initWith(cfg.nfi, rootArr, payout), () => [], {
        onOk: async () => {
          const ea = await conn.getAccountInfo(escrow, "confirmed");
          const va = await conn.getAccountInfo(vault, "confirmed");
          L = {
            id, kind, m, creator, escrow, vault, payout, treasury, windowEnd, groups, permit, stalePermit: null, finals, tree,
            status: "open", cancelledBy: "nobody", cancelledAt: 0, paused: false, feeReleased: false, collReturned: false,
            priceIn: 0, feeIn: 0, priceRefunded: 0, feeRefunded: 0, receipts: 0, receiptsOpen: 0, revealed: 0,
            vaultLamports: va!.lamports, escrowLamports: ea!.lamports, stray: 0, assets: [], counters: new Map(),
            log: [...adminLog.slice(-4).map((x) => "(admin) " + x)], tainted: false, burstDone: false, graceReturned: false,
            flow: { inPay: 0, inStray: 0, outPayout: 0, outTreasury: 0, outRefund: 0, outCreator: 0 },
          };
          need(va!.lamports === VAULT_RENT, `vault starts at ${va!.lamports}, rent ${VAULT_RENT}`);
          need((await collectionAuthority(L)) === escrow.toBase58(), "collection not handed to the escrow at init");
          const a = await cmAuthorities(m.cm);
          need(a.authority.equals(escrow) && a.mintAuthority.equals(escrow), "machine authority / mint authority not the escrow");
          const e: any = await program.account.launchEscrow.fetch(escrow, "confirmed");
          need(e.treasury.toBase58() === treasury.toBase58() && e.payout.toBase58() === payout.publicKey.toBase58() && Number(e.itemsAvailable) === items, "escrow fields at init");
        },
      });
      if (L) { pool.push(L); S.launches++; S.kinds[kind] = (S.kinds[kind] ?? 0) + 1; await checkInvariants(L); }
      return L;
    };

    // ---- the actions ----
    const others = (w: W | null) => wallets.filter((x) => x !== w);
    const signerFor = (a: Asset) => {
      if (!a.owner) return rng.pick([...wallets, crankerW, strangerW]);
      const k = rng.f();
      return k < 0.6 ? a.owner : k < 0.85 ? rng.pick(others(a.owner)) : strangerW;
    };

    /** The model's update after a successful pay_and_mint (shared with the deadline burst). */
    const applyMint = async (L: Launch, w: W, gi: number, assetPk: PublicKey, nowT?: number) => {
      const g = L.groups[gi]!;
      const r: any = await program.account.mintReceipt.fetch(receiptPda(L.escrow, assetPk), "confirmed");
      const mintIndex = r.mintIndex.toNumber();
      need(mintIndex === L.receipts, `mint_index ${mintIndex} != receipts before the mint ${L.receipts}`);
      if (nowT !== undefined) need(r.paidAt.toNumber() < L.windowEnd, `paid_at ${r.paidAt} not before window_end ${L.windowEnd}`);
      L.assets.push({ key: assetPk, owner: w, state: "live", rec: { minter: w, price: g.price, fee: g.fee, gi, open: true, refunded: false, mintIndex, revealed: false } });
      L.priceIn += g.price; L.feeIn += g.fee; L.receipts++; L.receiptsOpen++; L.vaultLamports += g.price + g.fee; L.flow.inPay += g.price + g.fee;
      g.minted++;
      const k = ckey(w, gi);
      const c = L.counters.get(k);
      if (c) c.count++; else L.counters.set(k, { w, gi, count: 1, open: true });
      const ai = await conn.getAccountInfo(assetPk, "confirmed");
      need(!!ai && ai.owner.equals(CORE) && ai.data[0] === 1 && new PublicKey(ai.data.subarray(1, 33)).equals(w.kp.publicKey), "minted asset missing or wrong owner");
    };
    const payAndMintIx = (L: Launch, w: W, gi: number, asset: Keypair, permit: Keypair, o: { vault?: PublicKey; collection?: PublicKey } = {}) =>
      program.methods.payAndMint(gi).accounts({
        escrow: L.escrow, vault: o.vault ?? L.vault, receipt: receiptPda(L.escrow, asset.publicKey), counter: counterPda(L.escrow, w.kp.publicKey, gi), asset: asset.publicKey, minter: w.kp.publicKey,
        permit: permit.publicKey, candyMachine: L.m.cm, candyMachineAuthority: L.m.authorityPda, collection: o.collection ?? L.m.collection, candyMachineProgram: CANDY_MACHINE, mplCoreProgram: CORE,
        systemProgram: SystemProgram.programId, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
      } as any).preInstructions(cu());
    const mintReasons = (L: Launch, w: W, gi: number, permitOk: boolean) => (t: number) => {
      if (L.status === "closed") return ["AccountNotInitialized"];
      const r: string[] = [];
      if (!permitOk) r.push("NotPermit");
      if (L.status !== "open") r.push("NotOpen");
      if (L.paused) r.push("Paused");
      if (t >= L.windowEnd) r.push("WindowOver");
      const g = L.groups[gi];
      if (!g) r.push("BadGroup");
      else {
        if (t < g.start) r.push("PhaseNotStarted");
        if (t >= closes(L, g)) r.push("PhaseEnded");
        if (g.allocation && g.minted >= g.allocation) r.push("PhaseSoldOut");
        const c = L.counters.get(ckey(w, gi));
        if (g.perWallet && (c?.count ?? 0) >= g.perWallet) r.push("WalletLimit");
      }
      if (L.receipts >= L.m.items) r.push(...CM_EMPTY);
      return r;
    };

    const aMint = async (L: Launch) => {
      const w = rng.pick(wallets);
      const k = rng.f();
      const variant = k < 0.8 ? "honest" : k < 0.86 ? "badGroup" : k < 0.93 ? "stalePermit" : "strangerPermit";
      const t = await chainTime("processed");
      const openGs = L.groups.map((g, i) => ({ g, i })).filter(({ g }) => t >= g.start && t < closes(L, g)).map(({ i }) => i);
      let gi = openGs.length && rng.chance(0.75) ? rng.pick(openGs) : rng.int(L.groups.length);
      if (variant === "badGroup") gi = L.groups.length + rng.int(4);
      const permit = variant === "stalePermit" ? (L.stalePermit ?? stranger) : variant === "strangerPermit" ? stranger : L.permit;
      const permitOk = permit.publicKey.equals(L.permit.publicKey);
      const asset = Keypair.generate();
      await act(L, "mint", `${variant} by ${w.name} g${gi} asset=${asset.publicKey.toBase58().slice(0, 6)}`, () => send(payAndMintIx(L, w, gi, asset, permit), [asset, w.kp, permit]), mintReasons(L, w, gi, permitOk), {
        onOk: () => applyMint(L, w, gi, asset.publicKey),
      });
    };

    const assetState = async (pk: PublicKey): Promise<"live" | "shell" | "collected"> => {
      const a = await conn.getAccountInfo(pk, "confirmed");
      if (!a || a.owner.equals(SystemProgram.programId)) return "collected";
      if (a.owner.equals(CORE) && a.data.length === 1 && a.data[0] === 0) return "shell";
      return "live";
    };

    const refundIx = (L: Launch, a: Asset, minter: PublicKey, signer: Keypair, coll: PublicKey, assetParam = a.key) =>
      program.methods.refund().accounts({ escrow: L.escrow, vault: L.vault, receipt: receiptPda(L.escrow, a.key), minter, asset: assetParam, collection: coll, signer: signer.publicKey, mplCoreProgram: CORE, systemProgram: SystemProgram.programId } as any).preInstructions(cu());
    const aRefund = async (L: Launch, forced?: { a: Asset; signer: W }) => {
      if (!L.assets.length) return;
      const a = forced?.a ?? rng.pick(L.assets);
      const signer = forced?.signer ?? signerFor(a);
      const live = a.state === "live";
      const wrongMinter = !forced && rng.chance(0.05);
      const wrongColl = !forced && live && rng.chance(0.06);
      const other = L.assets.find((x) => x !== a);
      const wrongAsset = !forced && !!other && rng.chance(0.04);
      const minterParam = wrongMinter ? stranger.publicKey : a.rec.minter.kp.publicKey;
      const collParam = wrongColl ? (pool.find((x) => x !== L)?.m.collection ?? stranger.publicKey) : L.m.collection;
      const reasons = () => {
        const r: string[] = [];
        if (L.status === "closed" || !a.rec.open) return ["AccountNotInitialized"];
        if (wrongMinter) r.push("ConstraintHasOne");
        if (wrongAsset) r.push("AssetUnreadable");
        if (L.status !== "cancelled") r.push("NotCancelled");
        if (live) { if (wrongColl) r.push("WrongCollection"); if (signer !== a.owner) r.push("NotOwner"); }
        return r;
      };
      const ownerB = a.owner ? await bal(a.owner.kp.publicKey) : 0;
      const minterB = await bal(a.rec.minter.kp.publicKey);
      const assetB = await lamportsOf(a.key);
      const recRent = await lamportsOf(receiptPda(L.escrow, a.key));
      const vaultB = await lamportsOf(L.vault);
      await act(L, "refund", `${a.key.toBase58().slice(0, 6)} by ${signer.name} (${live ? "owner " + a.owner!.name : a.state})${wrongMinter ? " wrongMinter" : ""}${wrongColl ? " wrongColl" : ""}${wrongAsset ? " wrongAsset" : ""}`,
        () => send(refundIx(L, a, minterParam, signer.kp, collParam, wrongAsset ? other!.key : a.key), [signer.kp]), reasons, {
          onOk: async () => {
            const r = a.rec;
            const amount = r.price + r.fee;
            const minterA = await bal(r.minter.kp.publicKey);
            need(vaultB - (await lamportsOf(L.vault)) === amount, "vault paid out more or less than the receipt");
            if (live) {
              const ownerA = await bal(a.owner!.kp.publicKey);
              const extra = a.owner === r.minter ? recRent : 0;
              need(ownerA - ownerB >= amount + extra && ownerA - ownerB <= amount + extra + assetB, `owner delta ${ownerA - ownerB} outside [${amount + extra}, ${amount + extra + assetB}]`);
              if (a.owner !== r.minter) need(minterA - minterB === recRent, `minter delta ${minterA - minterB} != receipt rent ${recRent}`);
              need((await assetState(a.key)) === "shell", "the asset was not burned by the refund");
              a.owner = null; a.state = "shell";
            } else {
              need(minterA - minterB === amount + recRent, `crank: minter delta ${minterA - minterB} != ${amount + recRent}`);
            }
            r.open = false; r.refunded = true;
            L.priceRefunded += r.price; L.feeRefunded += r.fee; L.receiptsOpen--; L.vaultLamports -= amount; L.flow.outRefund += amount;
          },
        });
    };

    const aTransfer = async (L: Launch) => {
      const live = L.assets.filter((a) => a.state === "live");
      if (!live.length) return;
      const a = rng.pick(live);
      const from = a.owner!;
      const to = rng.pick(others(from));
      await act(L, "transfer", `${a.key.toBase58().slice(0, 6)} ${from.name}->${to.name}`, async () => {
        const asset = await fetchAsset(from.umi, upk(a.key));
        const coll = await fetchCollection(from.umi, upk(L.m.collection));
        await usend(coreTransfer(from.umi, { asset, collection: coll, newOwner: upk(to.kp.publicKey) }), from.umi);
      }, () => [], {
        onOk: async () => {
          a.owner = to;
          const ai = await conn.getAccountInfo(a.key, "confirmed");
          need(new PublicKey(ai!.data.subarray(1, 33)).equals(to.kp.publicKey), "transfer did not move the asset");
        },
      });
    };

    const aSelfBurn = async (L: Launch) => {
      const live = L.assets.filter((a) => a.state === "live");
      if (!live.length) return;
      const a = rng.pick(live);
      const o = a.owner!;
      await act(L, "selfburn", `${a.key.toBase58().slice(0, 6)} by ${o.name}`, async () => {
        const asset = await fetchAsset(o.umi, upk(a.key));
        const coll = await fetchCollection(o.umi, upk(L.m.collection));
        await usend(coreBurn(o.umi, { asset, collection: coll }), o.umi);
      }, () => [], { onOk: async () => { a.owner = null; a.state = "shell"; need((await assetState(a.key)) === "shell", "self-burn left no shell"); } });
    };

    const aCollect = async (L: Launch) => {
      const shells = L.assets.filter((a) => a.state === "shell");
      if (!shells.length) return;
      const a = rng.pick(shells);
      await act(L, "collect", `${a.key.toBase58().slice(0, 6)}${a.rec.open ? " (receipt open)" : ""}`, () => usend(collect(crankerW.umi, {}).addRemainingAccounts({ pubkey: upk(a.key), isSigner: false, isWritable: true }), crankerW.umi), () => [], {
        onOk: async () => { need((await assetState(a.key)) === "collected", "Collect did not reassign the shell"); a.state = "collected"; },
      });
    };

    const aRelease = async (L: Launch, forced = false) => {
      const wrongPayout = !forced && rng.chance(0.08);
      const to_payout = L.priceIn - L.priceRefunded;
      const p0 = await bal(L.payout.publicKey);
      const reasons = (t: number) => {
        if (L.status === "closed") return ["AccountNotInitialized"];
        const r: string[] = [];
        if (wrongPayout) r.push("ConstraintHasOne");
        if (L.status !== "open") r.push("NotOpen");
        if (t < L.windowEnd) r.push("WindowNotOver");
        return r;
      };
      return act(L, "release", `to ${wrongPayout ? "a wrong payout" : "payout"} owed=${to_payout}`,
        () => send(program.methods.release().accounts({ escrow: L.escrow, vault: L.vault, payout: wrongPayout ? stranger.publicKey : L.payout.publicKey, signer: cranker.publicKey } as any).preInstructions(cu()), [cranker]), reasons, {
          onOk: async () => {
            const p1 = await bal(L.payout.publicKey);
            need(p1 - p0 === to_payout, `payout delta ${p1 - p0} != ${to_payout}`);
            L.status = "released"; L.vaultLamports -= to_payout; L.flow.outPayout += to_payout;
          },
        });
    };

    const aReleaseFee = async (L: Launch, forced = false) => {
      const wrongT = !forced && rng.chance(0.08);
      const amt = L.feeIn - L.feeRefunded;
      const t0b = await bal(L.treasury);
      const reasons = () => {
        if (L.status === "closed") return ["AccountNotInitialized"];
        const r: string[] = [];
        if (wrongT) r.push("ConstraintHasOne");
        if (L.status !== "released") r.push("NotReleased");
        if (L.feeReleased) r.push("AlreadyReleased");
        return r;
      };
      return act(L, "release_fee", `${wrongT ? "wrong treasury " : ""}owed=${amt}`,
        () => send(program.methods.releaseFee().accounts({ escrow: L.escrow, vault: L.vault, treasury: wrongT ? stranger.publicKey : L.treasury, signer: cranker.publicKey } as any).preInstructions(cu()), [cranker]), reasons, {
          onOk: async () => {
            const t1 = await bal(L.treasury);
            need(t1 - t0b === amt, `treasury delta ${t1 - t0b} != ${amt}`);
            L.feeReleased = true; L.vaultLamports -= amt; L.flow.outTreasury += amt;
          },
        });
    };

    const cancelIx = (L: Launch, signer: Keypair) => program.methods.cancel().accounts({ config: configPda, escrow: L.escrow, signer: signer.publicKey } as any).preInstructions(cu());
    const aCancel = async (L: Launch) => {
      const k = rng.f();
      const who = k < 0.3 ? { kp: L.creator.kp, n: "creator" } : k < 0.55 ? { kp: cfg.canceller, n: "canceller" } : k < 0.75 ? { kp: cfg.nfi, n: "hotNfi" } : k < 0.88 ? { kp: cfg.oldCanceller, n: "staleCanceller" } : { kp: stranger, n: "stranger" };
      const reasons = (t: number) => {
        if (L.status === "closed") return ["AccountNotInitialized"];
        const r: string[] = [];
        if (L.status !== "open") r.push("NotOpen");
        if (t >= L.windowEnd) r.push("WindowOver");
        if (who.n !== "creator" && who.n !== "canceller") r.push("NotCanceller");
        return r;
      };
      await act(L, "cancel", `by ${who.n}`, () => send(cancelIx(L, who.kp), [who.kp]), reasons, {
        onOk: async () => {
          const e: any = await program.account.launchEscrow.fetch(L.escrow, "confirmed");
          L.status = "cancelled"; L.cancelledBy = who.n === "canceller" ? "nfi" : "creator"; L.cancelledAt = e.cancelledAt.toNumber();
          need(L.cancelledAt < L.windowEnd, "cancelled at or after window_end");
        },
      });
    };

    const nfiEscrowAccounts = (L: Launch, signer: Keypair) => ({ config: configPda, escrow: L.escrow, nfiAuthority: signer.publicKey } as any);
    const aPause = async (L: Launch, forced?: boolean) => {
      const k = rng.f();
      const who = forced !== undefined || k < 0.72 ? { kp: cfg.nfi, n: "nfi" } : k < 0.82 ? { kp: cfg.oldNfi, n: "staleNfi" } : k < 0.91 ? { kp: cfg.canceller, n: "canceller" } : { kp: L.creator.kp, n: "creator" };
      const val = forced ?? rng.chance(L.paused ? 0.25 : 0.4);
      const reasons = () => { if (L.status === "closed") return ["AccountNotInitialized"]; return who.n !== "nfi" ? ["NotNfi"] : []; };
      await act(L, "set_paused", `${val} by ${who.n}`, () => send(program.methods.setPaused(val).accounts(nfiEscrowAccounts(L, who.kp)).preInstructions(cu()), [who.kp]), reasons, { onOk: () => { L.paused = val; } });
    };

    const aSetPermit = async (L: Launch) => {
      const k = rng.f();
      const who = k < 0.8 ? { kp: cfg.nfi, n: "nfi" } : k < 0.9 ? { kp: cfg.oldNfi, n: "staleNfi" } : { kp: L.creator.kp, n: "creator" };
      const toDefault = rng.chance(0.08);
      const next = Keypair.generate();
      const p = toDefault ? PublicKey.default : next.publicKey;
      const reasons = () => {
        if (L.status === "closed") return ["AccountNotInitialized"];
        const r: string[] = [];
        if (who.n !== "nfi") r.push("NotNfi");
        if (toDefault) r.push("BadConfig");
        return r;
      };
      await act(L, "set_permit", `${toDefault ? "default key" : "new key"} by ${who.n}`, () => send(program.methods.setPermit(p).accounts(nfiEscrowAccounts(L, who.kp)).preInstructions(cu()), [who.kp]), reasons, {
        onOk: () => { L.stalePermit = L.permit; L.permit = next; },
      });
    };

    const aSetGroup = async (L: Launch) => {
      const k = rng.f();
      const signers = k < 0.8 ? { nfi: cfg.nfi, cr: L.creator.kp, n: "nfi+creator" } : k < 0.9 ? { nfi: cfg.oldNfi, cr: L.creator.kp, n: "staleNfi+creator" } : { nfi: cfg.nfi, cr: stranger, n: "nfi+stranger" };
      const gi = rng.chance(0.08) ? L.groups.length + rng.int(3) : rng.int(L.groups.length);
      const t = await chainTime("processed");
      const start = t + rng.int(18) - 2;
      const endK = rng.f();
      const end = endK < 0.45 ? 0 : endK < 0.85 ? start + 3 + rng.int(15) : start - 1;
      const perWallet = rng.pick([0, 1, 2, 3]);
      const allocation = rng.pick([0, 1, 2, 4, 8]);
      const reasons = (now: number) => {
        if (L.status === "closed") return ["AccountNotInitialized"];
        const r: string[] = [];
        if (signers.n === "staleNfi+creator") r.push("NotNfi");
        if (signers.n === "nfi+stranger") r.push("NotCreator");
        if (L.status !== "open") r.push("NotOpen");
        const g = L.groups[gi];
        if (!g) { r.push("BadGroup"); return r; }
        if (!(now < g.start && start > now)) r.push("PhaseStarted");
        if (!(start < L.windowEnd && (end === 0 || (end > start && end <= L.windowEnd)))) r.push("BadPhase");
        return r;
      };
      await act(L, "set_group", `g${gi} start=${start - t} end=${end ? end - t : 0} pw=${perWallet} alloc=${allocation} by ${signers.n}`,
        () => send(program.methods.setGroup(gi, new BN(start), new BN(end), perWallet, allocation).accounts({ config: configPda, escrow: L.escrow, nfiAuthority: signers.nfi.publicKey, creator: signers.cr.publicKey } as any).preInstructions(cu()), [signers.nfi, signers.cr]), reasons, {
          extraT: [start],
          onOk: () => { const g = L.groups[gi]!; g.start = start; g.end = end; g.perWallet = perWallet; g.allocation = allocation; },
        });
    };

    const revealIx = (L: Launch, a: Asset, name: string, uri: string, proof: Buffer[]) =>
      program.methods.reveal(name, uri, proof.map((p) => Array.from(p))).accounts({ escrow: L.escrow, receipt: receiptPda(L.escrow, a.key), asset: a.key, collection: L.m.collection, candyMachine: L.m.cm, payer: cranker.publicKey, mplCoreProgram: CORE, systemProgram: SystemProgram.programId } as any).preInstructions(cu());
    const aReveal = async (L: Launch, forced?: Asset) => {
      if (!L.assets.length) return;
      const cand = L.assets.filter((a) => a.rec.open && !a.rec.revealed);
      const a = forced ?? (cand.length && rng.chance(0.8) ? rng.pick(cand) : rng.pick(L.assets));
      const i = a.rec.mintIndex;
      const k = forced ? 0 : rng.f();
      const variant = k < 0.7 ? "right" : k < 0.85 ? "otherItem" : "wrongUri";
      const j = (i + 1) % L.m.items;
      const name = variant === "otherItem" ? L.finals[j]!.name : L.finals[i]!.name;
      const uri = variant === "otherItem" ? L.finals[j]!.uri : variant === "wrongUri" ? "https://example.com/x/rug.json" : L.finals[i]!.uri;
      const proof = L.tree ? (variant === "otherItem" ? L.tree.proofs[j]! : L.tree.proofs[i]!) : [];
      const reasons = (t: number) => {
        if (L.status === "closed" || !a.rec.open) return ["AccountNotInitialized"];
        if (!hasReveal(L)) return ["NoReveal"];
        const r: string[] = [];
        if (L.collReturned) r.push("CollectionReturned");
        if (a.rec.revealed) r.push("AlreadyRevealed");
        const mintingOver = L.status !== "open" || t >= L.windowEnd || L.receipts >= L.m.items;
        if (!mintingOver) r.push("MintingNotOver");
        if (variant !== "right") r.push("BadRevealProof");
        if (r.length === 0 && a.state !== "live") r.push(CORE_FAIL); // the asset is burned: Core refuses the update
        return r;
      };
      await act(L, "reveal", `${a.key.toBase58().slice(0, 6)} #${i} ${variant} (${a.state}${a.rec.revealed ? ", revealed" : ""})`, () => send(revealIx(L, a, name, uri, proof), [cranker]), reasons, {
        onOk: async () => {
          a.rec.revealed = true; L.revealed++;
          const x = await fetchAsset(crankerW.umi, upk(a.key));
          need(x.uri === L.finals[i]!.uri && x.name === L.finals[i]!.name, "reveal did not write the committed metadata");
          need(x.immutableMetadata !== undefined, "the revealed asset is not locked");
        },
      });
    };

    const isFinal = (L: Launch, t: number) => L.status === "released" ? (!hasReveal(L) || L.revealed >= L.receipts || t >= L.windowEnd + GRACE)
      : L.status === "cancelled" ? (L.receiptsOpen === 0 || t >= L.cancelledAt + GRACE) : false;
    const aReturn = async (L: Launch, forced = false) => {
      const wrongCreator = !forced && rng.chance(0.1);
      const reasons = (t: number) => {
        if (L.status === "closed") return ["AccountNotInitialized"];
        const r: string[] = [];
        if (wrongCreator) r.push("NotCreator");
        if (L.collReturned) r.push("CollectionReturned");
        if (!isFinal(L, t)) r.push("NotFinal");
        return r;
      };
      return act(L, "return_collection", `${wrongCreator ? "to a stranger" : "to the creator"} (${L.status}, open receipts ${L.receiptsOpen}, revealed ${L.revealed}/${L.receipts})`,
        () => send(program.methods.returnCollection().accounts({ escrow: L.escrow, collection: L.m.collection, candyMachine: L.m.cm, creator: wrongCreator ? stranger.publicKey : L.creator.kp.publicKey, payer: cranker.publicKey, candyMachineProgram: CANDY_MACHINE, mplCoreProgram: CORE, systemProgram: SystemProgram.programId } as any).preInstructions(cu()), [cranker]), reasons, {
          onOk: async (t) => {
            L.collReturned = true;
            if (L.status === "cancelled" && L.receiptsOpen > 0) { L.graceReturned = true; observe("cancel-grace return with refunds open"); }
            if (L.status === "released" && hasReveal(L) && L.revealed < L.receipts) observe("reveal-grace return with reveals pending");
            need((await collectionAuthority(L)) === L.creator.kp.publicKey.toBase58(), "collection authority is not the creator after return");
            need((await cmAuthorities(L.m.cm)).authority.equals(L.creator.kp.publicKey), "machine authority is not the creator after return");
            void t;
          },
        });
    };

    const aCloseReceipt = async (L: Launch, forced?: Asset) => {
      if (!L.assets.length) return;
      const open = L.assets.filter((x) => x.rec.open);
      const a = forced ?? (open.length && rng.chance(0.9) ? rng.pick(open) : rng.pick(L.assets));
      const wrongMinter = !forced && rng.chance(0.06);
      const m0 = await bal(a.rec.minter.kp.publicKey);
      const rent = await lamportsOf(receiptPda(L.escrow, a.key));
      const reasons = () => {
        if (L.status === "closed" || !a.rec.open) return ["AccountNotInitialized"];
        const r: string[] = [];
        if (wrongMinter) r.push("ConstraintHasOne");
        if (L.status !== "released") r.push("NotFinal");
        if (hasReveal(L) && !a.rec.revealed && !L.collReturned) r.push("RevealPending");
        return r;
      };
      await act(L, "close_receipt", `${a.key.toBase58().slice(0, 6)}${wrongMinter ? " wrongMinter" : ""}`,
        () => send(program.methods.closeReceipt().accounts({ escrow: L.escrow, receipt: receiptPda(L.escrow, a.key), minter: wrongMinter ? stranger.publicKey : a.rec.minter.kp.publicKey, signer: cranker.publicKey } as any).preInstructions(cu()), [cranker]), reasons, {
          onOk: async () => {
            const m1 = await bal(a.rec.minter.kp.publicKey);
            need(m1 - m0 === rent, `close_receipt: minter delta ${m1 - m0} != ${rent}`);
            a.rec.open = false; L.receiptsOpen--;
          },
        });
    };

    const aCloseCounter = async (L: Launch, forced?: Counter) => {
      const cs = [...L.counters.values()];
      if (!cs.length) return;
      const c = forced ?? rng.pick(cs);
      const wrongMinter = !forced && rng.chance(0.06);
      const pk = counterPda(L.escrow, c.w.kp.publicKey, c.gi);
      const m0 = await bal(c.w.kp.publicKey);
      const rent = await lamportsOf(pk);
      const reasons = () => {
        if (L.status === "closed" || !c.open) return ["AccountNotInitialized"];
        const r: string[] = [];
        if (wrongMinter) r.push("ConstraintHasOne");
        if (L.status === "open") r.push("NotFinal");
        return r;
      };
      await act(L, "close_counter", `${c.w.name}/g${c.gi}${wrongMinter ? " wrongMinter" : ""}`,
        () => send(program.methods.closeCounter().accounts({ escrow: L.escrow, counter: pk, minter: wrongMinter ? stranger.publicKey : c.w.kp.publicKey, signer: cranker.publicKey } as any).preInstructions(cu()), [cranker]), reasons, {
          onOk: async () => { need((await bal(c.w.kp.publicKey)) - m0 === rent, "close_counter: minter delta != counter rent"); c.open = false; },
        });
    };

    const closeEscrowReasons = (L: Launch, asStranger: boolean) => () => {
      if (L.status === "closed") return ["AccountNotInitialized"];
      const r: string[] = [];
      if (asStranger) r.push("NotCreator");
      if (L.status === "open") r.push("NotFinal");
      if (L.receiptsOpen > 0) r.push("ReceiptsOpen");
      if (L.status === "released" && !L.feeReleased && L.feeIn !== L.feeRefunded) r.push("FeeNotReleased");
      if (!L.collReturned) r.push("NotFinal");
      return r;
    };
    const aCloseEscrow = async (L: Launch, forced = false) => {
      const asStranger = !forced && rng.chance(0.12);
      // close_escrow does not wait for the mint counters, and close_counter needs the escrow: closing it first strands the
      // counters' rent for good (reported separately, tests/audit-counter-stranded.ts). The walk closes counters first.
      const openCounters = [...L.counters.values()].filter((c) => c.open);
      if (!asStranger && openCounters.length && closeEscrowReasons(L, false)().length === 0) {
        observe("close_escrow would have stranded open mint counters (closed them first)");
        for (const c of openCounters) await aCloseCounter(L, c);
      }
      const signer = asStranger ? stranger : L.creator.kp;
      const c0 = await bal(L.creator.kp.publicKey);
      await act(L, "close_escrow", asStranger ? "by a stranger" : "by the creator",
        () => send(program.methods.closeEscrow().accounts({ escrow: L.escrow, vault: L.vault, creator: signer.publicKey } as any).preInstructions(cu()), [signer]), closeEscrowReasons(L, asStranger), {
          onOk: async () => {
            const c1 = await bal(L.creator.kp.publicKey);
            need(c1 - c0 === L.escrowLamports + L.vaultLamports, `creator delta ${c1 - c0} != escrow ${L.escrowLamports} + vault ${L.vaultLamports}`);
            L.flow.outCreator += L.vaultLamports - VAULT_RENT;
            const inn = L.flow.inPay + L.flow.inStray, out = L.flow.outPayout + L.flow.outTreasury + L.flow.outRefund + L.flow.outCreator;
            need(inn === out, `life of the launch: in ${inn} != out ${out}`);
            need(L.flow.outCreator === L.flow.inStray, `the creator's close took ${L.flow.outCreator} but only ${L.flow.inStray} was stray`);
            L.status = "closed"; L.vaultLamports = 0;
          },
        });
    };

    const aStray = async (L: Launch) => {
      if (L.status === "closed") return;
      const x = 1 + rng.int(20_000);
      await act(L, "stray", `${x} lamports into the vault`, () => sendTx(new Transaction().add(...cu(), SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: L.vault, lamports: x })), [stranger]), () => [], {
        onOk: () => { L.vaultLamports += x; L.stray += x; L.flow.inStray += x; },
      });
    };

    /** Mints that skip pay_and_mint: through the orphaned guard, or straight from the machine by the creator. Must fail. */
    const aBypass = async (L: Launch) => {
      if (L.status === "closed") return;
      const w = rng.pick(wallets);
      if (rng.chance(0.5)) {
        await act(L, "bypass", `guard mint_v1 by ${w.name}`, () => usend(mintV1(w.umi, { candyMachine: upk(L.m.cm), candyGuard: upk(L.m.guard), collection: upk(L.m.collection), asset: generateSigner(w.umi), group: none(), mintArgs: {} }), w.umi), () => [""]);
      } else {
        const u = L.creator.umi;
        await act(L, "bypass", "machine mint by the creator", () => usend(mintAssetFromCandyMachine(u, { candyMachine: upk(L.m.cm), mintAuthority: u.identity, assetOwner: u.identity.publicKey, asset: generateSigner(u), collection: upk(L.m.collection) }), u), () => [""]);
      }
    };

    const aCross = async (L: Launch) => {
      const B = pool.find((x) => x !== L && x.status !== "closed" && !x.tainted);
      if (!B || L.status === "closed") return;
      const op = rng.int(5);
      const bAsset = B.assets.find((a) => a.rec.open);
      if (op === 0) {
        await act(L, "cross", `release with ${B.id}'s vault`, () => send(program.methods.release().accounts({ escrow: L.escrow, vault: B.vault, payout: L.payout.publicKey, signer: cranker.publicKey } as any).preInstructions(cu()), [cranker]), () => ["ConstraintSeeds"]);
      } else if (op === 1 && bAsset) {
        const s = bAsset.owner ?? crankerW;
        await act(L, "cross", `refund ${B.id}'s receipt through this escrow`, () => send(program.methods.refund().accounts({ escrow: L.escrow, vault: L.vault, receipt: receiptPda(B.escrow, bAsset.key), minter: bAsset.rec.minter.kp.publicKey, asset: bAsset.key, collection: B.m.collection, signer: s.kp.publicKey, mplCoreProgram: CORE, systemProgram: SystemProgram.programId } as any).preInstructions(cu()), [s.kp]), () => ["ConstraintSeeds", "ConstraintHasOne"]);
      } else if (op === 2 && bAsset) {
        await act(L, "cross", `close ${B.id}'s receipt through this escrow`, () => send(program.methods.closeReceipt().accounts({ escrow: L.escrow, receipt: receiptPda(B.escrow, bAsset.key), minter: bAsset.rec.minter.kp.publicKey, signer: cranker.publicKey } as any).preInstructions(cu()), [cranker]), () => ["ConstraintSeeds", "ConstraintHasOne"]);
      } else if (op === 3) {
        const w = rng.pick(wallets), asset = Keypair.generate();
        await act(L, "cross", `pay_and_mint into ${B.id}'s vault`, () => send(payAndMintIx(L, w, 0, asset, L.permit, { vault: B.vault }), [asset, w.kp, L.permit]), () => ["ConstraintSeeds", "AccountNotInitialized"]);
      } else {
        await act(L, "cross", `close_escrow with ${B.id}'s vault`, () => send(program.methods.closeEscrow().accounts({ escrow: L.escrow, vault: B.vault, creator: L.creator.kp.publicKey } as any).preInstructions(cu()), [L.creator.kp]), () => ["ConstraintSeeds"]);
      }
    };

    const aAdmin = async () => {
      const k = rng.int(5);
      const note = (s: string) => { for (const L of pool) if (L.status !== "closed") L.log.push("(admin) " + s); };
      const ac = { config: configPda, authority: authority.publicKey } as any;
      if (k === 0) {
        const next = cfg.oldNfi;
        await act(null, "admin", "rotate NFI's hot key", () => send(program.methods.setNfiAuthority(next.publicKey).accounts(ac).preInstructions(cu()), []), () => [], { onOk: () => { cfg.oldNfi = cfg.nfi; cfg.nfi = next; note("rotate NFI's hot key"); } });
      } else if (k === 1) {
        const next = cfg.oldCanceller;
        await act(null, "admin", "rotate the canceller", () => send(program.methods.setCanceller(next.publicKey).accounts(ac).preInstructions(cu()), []), () => [], { onOk: () => { cfg.oldCanceller = cfg.canceller; cfg.canceller = next; note("rotate the canceller"); } });
      } else if (k === 2) {
        const next = cfg.treasury.equals(tA.publicKey) ? tB.publicKey : tA.publicKey;
        await act(null, "admin", "rotate the treasury", () => send(program.methods.setTreasury().accounts({ ...ac, treasury: next }).preInstructions(cu()), []), () => [], { onOk: () => { cfg.treasury = next; note("rotate the treasury (new escrows only)"); } });
      } else if (k === 3) {
        await act(null, "admin", "set_canceller to the hot key", () => send(program.methods.setCanceller(cfg.nfi.publicKey).accounts(ac).preInstructions(cu()), []), () => ["BadConfig"]);
      } else {
        await act(null, "admin", "set_nfi_authority by a stranger", () => send(program.methods.setNfiAuthority(stranger.publicKey).accounts({ config: configPda, authority: stranger.publicKey } as any).preInstructions(cu()), [stranger]), () => ["NotAuthority"]);
      }
    };

    /** At the deadline: wait until the chain clock is one second short of window_end, then fire pay_and_mint, cancel and
     *  release at once. Exactly the outcomes the clock allows: never both cancel and release, nothing before-window after it. */
    const aBurst = async (L: Launch) => {
      L.burstDone = true;
      for (;;) { const t = await chainTime("processed"); if (t >= L.windowEnd - 1) break; if (Date.now() - t0 > MAX_MS + 120_000) return; await sleep(150); }
      const w = rng.pick(wallets);
      const gi = rng.int(L.groups.length);
      const asset = Keypair.generate();
      const canceller = rng.chance(0.5) ? L.creator.kp : cfg.canceller;
      const p0 = await bal(L.payout.publicKey);
      const payF = () => send(payAndMintIx(L, w, gi, asset, L.permit), [asset, w.kp, L.permit]);
      const cancelF = () => send(cancelIx(L, canceller), [canceller]);
      const releaseF = () => send(program.methods.release().accounts({ escrow: L.escrow, vault: L.vault, payout: L.payout.publicKey, signer: cranker.publicKey } as any).preInstructions(cu()), [cranker]);
      const tb = await chainTime("confirmed");
      const [rp, rc, rr] = await Promise.all([run(payF), run(cancelF), run(releaseF)]);
      const ta = await chainTime("processed");
      S.actions += 3; S.byType["burst"] = (S.byType["burst"] ?? 0) + 3;
      const d = `deadline burst [t ${tb - L.windowEnd}..${ta - L.windowEnd}] pay(g${gi}):${rp.ok ? "ok" : "fail"} cancel:${rc.ok ? "ok" : "fail"} release:${rr.ok ? "ok" : "fail"}`;
      L.log.push(d);
      const payAllowed = ["NotOpen", "WindowOver", "Paused", "PhaseNotStarted", "PhaseEnded", "PhaseSoldOut", "WalletLimit", ...CM_EMPTY];
      for (const [o, n, allowed] of [[rp, "pay", payAllowed], [rc, "cancel", ["NotOpen", "WindowOver"]], [rr, "release", ["NotOpen", "WindowNotOver"]]] as [Outcome, string, string[]][]) {
        if (!o.ok && FLAKE.test(o.msg) && !/Error Code|custom program error|"Custom"/.test(o.msg)) { flakes.push(`${seed}/${L.id}: burst ${n}: ${o.msg.slice(0, 160)}`); L.tainted = true; return; }
        if (o.ok) S.ok++; else if (allowed.some((x) => o.msg.includes(x))) S.expectedFail++; else violation(L, `${d}: ${n} failed unexpectedly: ${o.msg.slice(0, 300)}`);
      }
      if (rc.ok && rr.ok) violation(L, `${d}: both cancel and release succeeded`);
      if (rr.ok && ta < L.windowEnd) violation(L, `${d}: release succeeded before the deadline`);
      if (rp.ok) { try { await applyMint(L, w, gi, asset.publicKey, 0); } catch (e: any) { violation(L, `${d}: ${e.message}`); } }
      if (rc.ok) {
        const e: any = await program.account.launchEscrow.fetch(L.escrow, "confirmed");
        L.status = "cancelled"; L.cancelledBy = canceller === cfg.canceller ? "nfi" : "creator"; L.cancelledAt = e.cancelledAt.toNumber();
        if (L.cancelledAt >= L.windowEnd) violation(L, `${d}: cancelled at ${L.cancelledAt} >= window_end`);
      }
      if (rr.ok) {
        const owed = L.priceIn - L.priceRefunded;
        const p1 = await bal(L.payout.publicKey);
        if (p1 - p0 !== owed) violation(L, `${d}: payout delta ${p1 - p0} != ${owed} (a payment in the burst not counted?)`);
        L.status = "released"; L.vaultLamports -= owed; L.flow.outPayout += owed;
      }
      await checkInvariants(L);
    };

    const waitChain = async (t: number) => { while ((await chainTime("confirmed")) < t) await sleep(300); };

    // ---- the random walk ----
    const live = () => pool.filter((L) => L.status !== "closed" && !L.tainted);
    while (S.actions < MAX_ACTIONS && Date.now() - t0 < MAX_MS) {
      if (live().length < 3 && (live().length === 0 || rng.chance(0.15))) { await newLaunch(); continue; }
      while (pool.filter((L) => L.status === "closed").length > 2) pool.splice(pool.findIndex((L) => L.status === "closed"), 1);
      const cands = pool.filter((L) => !L.tainted);
      if (!cands.length) { await newLaunch(); continue; }
      const liveC = cands.filter((L) => L.status !== "closed");
      const L = liveC.length && !rng.chance(0.06) ? rng.pick(liveC) : rng.pick(cands); // a closed launch now and then
      if (L.status === "open" && !L.burstDone && rng.chance(0.08)) {
        const t = await chainTime("processed");
        if (L.windowEnd - t > 0 && L.windowEnd - t <= 20) { await aBurst(L); continue; }
      }
      const st = L.status;
      const weights: [number, () => Promise<any>][] = [
        [st === "open" ? 30 : 3, () => aMint(L)],
        [st === "cancelled" ? 20 : 4, () => aRefund(L)],
        [4, () => aTransfer(L)],
        [1.6, () => aSelfBurn(L)],
        [1.2, () => aCollect(L)],
        [st === "open" ? 4 : 1.2, () => aRelease(L)],
        [st === "released" ? 5 : 1.2, () => aReleaseFee(L)],
        [st === "open" ? 1.0 : 0.6, () => aCancel(L)],
        [2.2, () => aPause(L)],
        [1.2, () => aSetPermit(L)],
        [st === "open" ? 2.5 : 0.6, () => aSetGroup(L)],
        [hasReveal(L) ? (st === "open" ? 3 : 8) : 0.6, () => aReveal(L)],
        [st === "released" ? 10 : 1.5, () => aCloseReceipt(L)],
        [st !== "open" ? 2.5 : 0.8, () => aCloseCounter(L)],
        [st !== "open" ? 3.5 : 0.8, () => aReturn(L)],
        [st !== "open" ? 3 : 0.8, () => aCloseEscrow(L)],
        [0.8, () => aStray(L)],
        [0.8, () => aBypass(L)],
        [1.2, () => aCross(L)],
        [0.6, () => aAdmin()],
      ];
      const total = weights.reduce((s, [w]) => s + w, 0);
      let x = rng.f() * total;
      for (const [w, f] of weights) { if ((x -= w) < 0) { await f(); break; } }
    }

    // ---- drain: every launch to its end; everyone the model says is owed must be paid ----
    draining = true;
    let graceDrains = 0;
    for (const L of pool) {
      if (L.tainted || L.status === "closed") continue;
      if (L.status === "open") {
        if (L.paused) await aPause(L, false);
        await waitChain(L.windowEnd);
        await aRelease(L, true);
      }
      if (L.status === "released") {
        if (!L.feeReleased) await aReleaseFee(L, true);
        if (hasReveal(L) && !L.collReturned) for (const a of L.assets) if (a.rec.open && !a.rec.revealed && a.state === "live") await aReveal(L, a);
        if (!L.collReturned && hasReveal(L) && L.revealed < L.receipts) await waitChain(L.windowEnd + GRACE);
        if (!L.collReturned) await aReturn(L, true);
        for (const a of L.assets) if (a.rec.open) await aCloseReceipt(L, a);
      }
      if (L.status === "cancelled") {
        // the grace path: the collection goes back first, then every open receipt must still refund
        if (!L.collReturned && L.receiptsOpen > 0 && (graceDrains === 0 || rng.chance(0.5))) {
          graceDrains++;
          await waitChain(L.cancelledAt + GRACE);
          await aReturn(L, true);
        }
        for (const a of L.assets) if (a.rec.open) await aRefund(L, { a, signer: a.state === "live" ? a.owner! : rng.pick([crankerW, strangerW, ...wallets]) });
        if (!L.collReturned) await aReturn(L, true);
      }
      for (const c of L.counters.values()) if (c.open) await aCloseCounter(L, c);
      await aCloseEscrow(L, true);
      if (!L.tainted && (L.status as Status) !== "closed") violation(L, "drain could not close this launch: someone owed may be stuck");
      if (!L.tainted && L.assets.some((a) => a.rec.open)) violation(L, "drain left a receipt open");
    }
    for (const L of pool) if (!L.tainted && L.status === "closed" && (await collectionAuthority(L)) !== L.creator.kp.publicKey.toBase58()) violation(L, "collection not back with the creator after close");
    S.ms = Date.now() - t0;
    summaries.push(S);
    console.log(`PROP SEED ${seed}: ${JSON.stringify({ ...S, failReasons: undefined })}`);
  };

  for (const seed of SEEDS) {
    it(`seed ${seed}: random walk with the model checked after every action, then everything drained`, async function () {
      this.timeout(0);
      await runSeed(seed);
    });
  }

  after(() => {
    console.log("PROP SUMMARY " + JSON.stringify({ seeds: summaries.map((s) => ({ seed: s.seed, actions: s.actions, ok: s.ok, expectedFail: s.expectedFail, launches: s.launches, kinds: s.kinds, drainActions: s.drainActions, minutes: +(s.ms / 60000).toFixed(1), byType: s.byType, okByType: s.okByType, failReasons: s.failReasons })), totalActions: summaries.reduce((a, s) => a + s.actions, 0), violations: violations.length, flakes: flakes.length, observations }));
    for (const f of flakes) console.log("PROP FLAKE " + f);
    for (const v of violations) console.log(`PROP VIOLATION-FINAL seed=${v.seed} ${v.launch}: ${v.what}\n    seq: ${v.seq.join(" | ")}`);
  });

  it("no invariant violations across all seeds", () => {
    expect(violations.map((v) => `${v.seed}/${v.launch}: ${v.what}`)).to.deep.equal([]);
  });
});
