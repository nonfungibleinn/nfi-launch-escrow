// Audit finding from the property test (tests/audit-property.ts): close_escrow does not wait for the mint counters, and
// close_counter needs the escrow account, so once the creator closes the escrow every counter still open keeps its rent
// (the minter's lamports) for good. The machine cannot be re-escrowed (items_redeemed > 0), so nothing can recover it.
// EXPECTED TO FAIL against revision 0.5: it asserts the property that should hold (the counter's rent is recoverable).
//   instructions/close.rs  close_escrow: checks receipts_open but nothing about counters
//   instructions/pay.rs    CloseCounter: `escrow: Box<Account<LaunchEscrow>>` with seeds, so it cannot run once the escrow is closed
// Suggested fix (either): count open counters on the escrow (incremented when pay_and_mint creates one, decremented by
// close_counter) and require zero in close_escrow; or let close_counter accept an escrow address that no longer holds a
// LaunchEscrow (UncheckedAccount, PDA re-derived from the counter's stored escrow + the machine, closed = not Open).
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { generateSigner, keypairIdentity, some, none } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { createCollection as createCoreCollection, mplCore } from "@metaplex-foundation/mpl-core";
import { addConfigLines, create as createMachine, findCandyMachineAuthorityPda, mplCandyMachine } from "@metaplex-foundation/mpl-core-candy-machine";
import { expect } from "chai";
import type { NfiLaunchEscrow } from "../target/types/nfi_launch_escrow";

const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const CANDY_MACHINE = new PublicKey("CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J");
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

describe("audit: a mint counter's rent after close_escrow", () => {
  const provider = anchor.AnchorProvider.env();
  (provider.opts as any).commitment = "confirmed";
  anchor.setProvider(provider);
  const program = anchor.workspace.NfiLaunchEscrow as Program<NfiLaunchEscrow>;
  const conn = provider.connection;
  const authority = (provider.wallet as anchor.Wallet).payer;
  const creator = Keypair.generate(), nfi = Keypair.generate(), canceller = Keypair.generate(), permit = Keypair.generate(), minter = Keypair.generate(), treasury = Keypair.generate();
  const airdrop = async (pk: PublicKey, sol: number) => { const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL); await conn.confirmTransaction(sig, "confirmed"); };
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config2")], program.programId);
  const umi = createUmi(conn.rpcEndpoint, { commitment: "confirmed" }).use(mplCore()).use(mplCandyMachine()).use(keypairIdentity(fromWeb3JsKeypair(creator)));

  it("the minter's counter rent stays recoverable after the creator closes the escrow", async () => {
    await Promise.all([airdrop(creator.publicKey, 20), airdrop(nfi.publicKey, 1), airdrop(minter.publicKey, 10), airdrop(treasury.publicKey, 1)]);
    const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_LOADER_UPGRADEABLE);
    if (!(await conn.getAccountInfo(configPda, "confirmed"))) {
      await program.methods.initConfig(nfi.publicKey, canceller.publicKey).accounts({ config: configPda, authority: authority.publicKey, program: program.programId, programData, treasury: treasury.publicKey, systemProgram: SystemProgram.programId } as any).rpc();
    } else {
      await program.methods.setCanceller(canceller.publicKey).accounts({ config: configPda, authority: authority.publicKey } as any).rpc();
      await program.methods.setNfiAuthority(nfi.publicKey).accounts({ config: configPda, authority: authority.publicKey } as any).rpc();
    }
    // a one-item machine and its escrow
    const coll = generateSigner(umi), cmS = generateSigner(umi);
    await createCoreCollection(umi, { collection: coll, name: "C", uri: "https://example.com/c.json" }).sendAndConfirm(umi);
    await (await createMachine(umi, { candyMachine: cmS, collection: coll.publicKey, collectionUpdateAuthority: umi.identity, itemsAvailable: 1, configLineSettings: some({ prefixName: "I #", nameLength: 4, prefixUri: "https://example.com/", uriLength: 8, isSequential: false }), hiddenSettings: none(), guards: {} })).sendAndConfirm(umi);
    await addConfigLines(umi, { candyMachine: cmS.publicKey, index: 0, configLines: [{ name: "1", uri: "1.json" }] }).sendAndConfirm(umi);
    const cm = toWeb3JsPublicKey(cmS.publicKey), collection = toWeb3JsPublicKey(coll.publicKey);
    const [escrow] = PublicKey.findProgramAddressSync([Buffer.from("launch"), cm.toBuffer()], program.programId);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), escrow.toBuffer()], program.programId);
    const now = Math.floor(Date.now() / 1000);
    await program.methods.init({ windowEnd: new BN(now + 120), permit: permit.publicKey, revealRoot: Array.from(Buffer.alloc(32)), groups: [{ label: Array.from(Buffer.from("pub\0\0\0")), price: new BN(1_000_000), fee: new BN(0), start: new BN(0), end: new BN(0), perWallet: 0, allocation: 0 }] })
      .accounts({ config: configPda, escrow, vault, candyMachine: cm, collection, payout: creator.publicKey, creator: creator.publicKey, nfiAuthority: nfi.publicKey, candyMachineProgram: CANDY_MACHINE, mplCoreProgram: CORE, systemProgram: SystemProgram.programId } as any)
      .signers([creator, nfi]).rpc();
    // one paid mint: a receipt and a counter, both paid for by the minter
    const asset = Keypair.generate();
    const receipt = PublicKey.findProgramAddressSync([Buffer.from("receipt"), escrow.toBuffer(), asset.publicKey.toBuffer()], program.programId)[0];
    const counter = PublicKey.findProgramAddressSync([Buffer.from("minted"), escrow.toBuffer(), minter.publicKey.toBuffer(), Buffer.from([0])], program.programId)[0];
    await program.methods.payAndMint(0).accounts({
      escrow, vault, receipt, counter, asset: asset.publicKey, minter: minter.publicKey, permit: permit.publicKey, candyMachine: cm, candyMachineAuthority: toWeb3JsPublicKey(findCandyMachineAuthorityPda(umi, { candyMachine: cmS.publicKey })[0]),
      collection, candyMachineProgram: CANDY_MACHINE, mplCoreProgram: CORE, systemProgram: SystemProgram.programId, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
    } as any).preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).signers([asset, minter, permit]).rpc();
    // cancel, the owner refunds (the receipt closes), the collection goes back, the creator closes the escrow: all allowed
    await program.methods.cancel().accounts({ config: configPda, escrow, signer: creator.publicKey } as any).signers([creator]).rpc();
    await program.methods.refund().accounts({ escrow, vault, receipt, minter: minter.publicKey, asset: asset.publicKey, collection, signer: minter.publicKey, mplCoreProgram: CORE, systemProgram: SystemProgram.programId } as any).signers([minter]).rpc();
    await program.methods.returnCollection().accounts({ escrow, collection, candyMachine: cm, creator: creator.publicKey, payer: creator.publicKey, candyMachineProgram: CANDY_MACHINE, mplCoreProgram: CORE, systemProgram: SystemProgram.programId } as any).signers([creator]).rpc();
    // the fix: the escrow cannot close while a counter (the minter's rent) is open; closing the counter first returns it
    let err = "";
    try { await program.methods.closeEscrow().accounts({ escrow, vault, creator: creator.publicKey } as any).signers([creator]).rpc(); }
    catch (e: any) { err = String(e?.message ?? e) + JSON.stringify(e?.logs ?? []); }
    expect(err, "close_escrow with a counter open").to.include("CountersOpen");
    const m0 = await conn.getBalance(minter.publicKey, "confirmed");
    await program.methods.closeCounter().accounts({ escrow, counter, minter: minter.publicKey, signer: creator.publicKey } as any).signers([creator]).rpc();
    expect((await conn.getAccountInfo(counter, "confirmed"))?.lamports ?? 0).to.equal(0);
    expect(await conn.getBalance(minter.publicKey, "confirmed")).to.be.greaterThan(m0); // the rent went back to the minter
    await program.methods.closeEscrow().accounts({ escrow, vault, creator: creator.publicKey } as any).signers([creator]).rpc();
  });
});
