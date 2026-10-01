// Creates (or shows) the program's config with the upgrade authority's wallet. No Anchor client: the instruction is
// built by hand from the IDL (discriminator + one pubkey argument), the way the service builds every other one.
//   RPC=https://api.devnet.solana.com node ops/init-config.mjs <nfi_authority> <treasury>
//   RPC=... node ops/init-config.mjs --show
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

const PROGRAM = new PublicKey("3qRS59TJmgaNUzKjKsUe3XGggodSXA9GHU9Q5u2ffE1n");
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const conn = new Connection(process.env.RPC ?? "https://api.devnet.solana.com", "confirmed");
const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM)[0];
const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], BPF_UPGRADEABLE)[0];
const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

async function show() {
  const a = await conn.getAccountInfo(configPda);
  if (!a) { console.log("config: none at", configPda.toBase58()); return; }
  const d = Buffer.from(a.data);
  let o = 8;
  const pk = () => { const v = new PublicKey(d.subarray(o, o + 32)); o += 32; return v; };
  const authority = pk();
  const pending = d[o++] === 1 ? pk() : null;
  const nfi = pk(), treasury = pk();
  console.log(JSON.stringify({ config: configPda.toBase58(), authority: authority.toBase58(), pendingAuthority: pending?.toBase58() ?? null, nfiAuthority: nfi.toBase58(), treasury: treasury.toBase58() }, null, 2));
}
if (process.argv[2] === "--show") { await show(); process.exit(0); }
const walletOf = () => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? `${homedir()}/.config/solana/id.json`, "utf8"))));
const send = async (ix, signer) => {
  const bh = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signer.publicKey, ...bh }).add(ix);
  tx.sign(signer);
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) { console.error("would fail:", JSON.stringify(sim.value.err), (sim.value.logs ?? []).slice(-4).join("\n")); process.exit(1); }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  return sig;
};
// --propose <new_authority>: the config authority proposes its successor (two-step; the successor accepts).
if (process.argv[2] === "--propose") {
  const next = new PublicKey(process.argv[3]);
  const w = walletOf();
  const ix = new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: configPda, isSigner: false, isWritable: true }, { pubkey: w.publicKey, isSigner: true, isWritable: false }], data: Buffer.concat([disc("propose_authority"), Buffer.from([1]), next.toBuffer()]) });
  console.log("propose_authority", await send(ix, w));
  await show();
  process.exit(0);
}
// --accept-ix <new_authority>: the accept_authority instruction the successor (a Squads vault) must execute, as base58 program id + account list + hex data.
if (process.argv[2] === "--accept-ix") {
  const next = new PublicKey(process.argv[3]);
  console.log(JSON.stringify({ programId: PROGRAM.toBase58(), accounts: [{ pubkey: configPda.toBase58(), isSigner: false, isWritable: true }, { pubkey: next.toBase58(), isSigner: true, isWritable: false }], data: disc("accept_authority").toString("hex") }, null, 2));
  process.exit(0);
}
const [nfiArg, treasuryArg] = process.argv.slice(2);
if (!nfiArg || !treasuryArg) { console.error("usage: init-config.mjs <nfi_authority> <treasury> | --show"); process.exit(2); }
const wallet = walletOf();
if (await conn.getAccountInfo(configPda)) { console.log("config already exists"); await show(); process.exit(0); }
const ix = new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: PROGRAM, isSigner: false, isWritable: false },
    { pubkey: programData, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(treasuryArg), isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([disc("init_config"), new PublicKey(nfiArg).toBuffer()]),
});
const bh = await conn.getLatestBlockhash("confirmed");
const tx = new Transaction({ feePayer: wallet.publicKey, ...bh }).add(ix);
tx.sign(wallet);
const sim = await conn.simulateTransaction(tx);
if (sim.value.err) { console.error("would fail:", JSON.stringify(sim.value.err), (sim.value.logs ?? []).slice(-4).join("\n")); process.exit(1); }
const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
console.log("init_config", sig);
await show();
