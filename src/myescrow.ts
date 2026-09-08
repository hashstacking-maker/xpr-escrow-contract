import { Contract, Table, Serialize, Name, Symbol, Asset, Action } from "@proton/contract";

// Escrow state table
@Table("escrows")
export class Escrow {
  @Serialize.primary
  id!: u64;
  sender!: Name;
  receiver!: Name;
  arbiter!: Name;
  amount!: Asset;
  status!: string; // "pending", "released", "refunded", "resolved", "tied"
  createdAt!: u64;
  resolvedAt!: u64;
  winnerAddress!: Name;
  matchId!: u64;
  isTie!: boolean;
}

// Match state table
@Table("matches")
export class Match {
  @Serialize.primary
  matchId!: u64;
  escrowId!: u64;
  player1!: Name;
  player2!: Name;
  winner!: Name;
  matchStatus!: string; // "active", "completed", "disputed", "tied"
  stakeAmount!: Asset;
  createdAt!: u64;
  isTie!: boolean;
}

// Configuration table
@Table("config")
export class Config {
  @Serialize.primary
  key!: u64;
  arbiter!: Name;
  treasury!: Name;
  platformFeeBP!: u16; // Fee in basis points (e.g., 200 = 2%)
  paused!: boolean;
}

@Contract
export class MyEscrow {
  private escrowTable = new Table<Escrow>(this.receiver, this.receiver, Name.fromString("escrows"));
  private matchTable = new Table<Match>(this.receiver, this.receiver, Name.fromString("matches"));
  private configTable = new Table<Config>(this.receiver, this.receiver, Name.fromString("config"));

  /**
   * Initialize contract configuration
   * Arbiter: xprotonarena - resolves disputes and releases funds
   * Treasury: xprotonarena - collects 2% platform fees
   * Escrow Account: xprotonarena - holds escrowed funds
   */
  @Action("initconfig")
  initconfig(arbiter: Name, treasury: Name): void {
    check(!this.configTable.exists(Name.fromString("config")), "Config already initialized");
    
    const config = new Config();
    config.key = 0;
    config.arbiter = arbiter; // xprotonarena
    config.treasury = treasury; // xprotonarena
    config.platformFeeBP = 200; // 2% fee by default
    config.paused = false;

    this.configTable.store(config, this.receiver);
  }

  /**
   * Handle incoming token transfers
   * Intercepts XPR transfers sent to xprotonarena escrow account
   */
  @Action("transfer", "notify")
  onTransfer(from: Name, to: Name, quantity: Asset, memo: string): void {
    // Only process transfers TO this contract (xprotonarena)
    if (to != this.receiver) {
      return;
    }

    check(!this.isPaused(), "Contract is paused");
    check(quantity.amount > 0, "Transfer amount must be positive");
    check(from != this.receiver, "Cannot transfer to self");

    // Create escrow entry
    const escrow = new Escrow();
    escrow.id = this.getNextEscrowId();
    escrow.sender = from;
    escrow.receiver = Name.fromString(""); // Will be set by arbiter
    escrow.arbiter = this.getConfig().arbiter; // xprotonarena
    escrow.amount = quantity;
    escrow.status = "pending";
    escrow.createdAt = currentTime();
    escrow.resolvedAt = 0;
    escrow.winnerAddress = Name.fromString("");
    escrow.matchId = 0;
    escrow.isTie = false;

    this.escrowTable.store(escrow, this.receiver);
  }

  /**
   * Release escrowed funds to winner
   * Deducts 2% fee and sends to xprotonarena treasury unless there's a tie
   * Can only be called by arbiter (xprotonarena)
   */
  @Action("release")
  release(escrowId: u64, winner: Name, isTie: boolean = false): void {
    const config = this.getConfig();
    check(hasAuth(config.arbiter), "Only arbiter (xprotonarena) can release funds");

    const escrow = this.escrowTable.get(escrowId);
    check(escrow.status == "pending", "Escrow is not in pending status");

    if (isTie) {
      // TIE CASE: Refund both players, no fee to treasury
      this.handleTieRefund(escrow);
    } else {
      // NORMAL CASE: Deduct 2% fee and payout to winner
      this.handleWinnerPayout(escrow, winner, config);
    }

    // Update escrow status
    escrow.status = isTie ? "tied" : "released";
    escrow.winnerAddress = winner;
    escrow.resolvedAt = currentTime();
    escrow.isTie = isTie;
    this.escrowTable.update(escrow, this.receiver);
  }

  /**
   * Handle tie scenario: refund both players without fee
   * Treasury (xprotonarena) receives no fee on ties
   */
  private handleTieRefund(escrow: Escrow): void {
    // Send full amount back to sender (player 1)
    this.sendInlineTransfer(
      this.receiver,
      escrow.sender,
      escrow.amount,
      "Match tie - full refund to player 1"
    );
    
    // Note: If there's a second player (receiver), you'll need a separate mechanism
    // to track and refund them. For now, ensure the sender gets their full stake back.
  }

  /**
   * Handle normal winner payout with 2% fee deduction
   * 2% fee goes to xprotonarena treasury
   */
  private handleWinnerPayout(escrow: Escrow, winner: Name, config: Config): void {
    // Calculate 2% platform fee
    const fee = (escrow.amount.amount * config.platformFeeBP) / 10000;
    const payoutAmount = escrow.amount.amount - fee;

    // Send payout to winner
    this.sendInlineTransfer(
      this.receiver,
      winner,
      Asset.from(payoutAmount, escrow.amount.symbol),
      "Match won - payout after 2% fee"
    );

    // Send 2% fee to xprotonarena treasury
    if (fee > 0) {
      this.sendInlineTransfer(
        this.receiver,
        config.treasury, // xprotonarena
        Asset.from(fee, escrow.amount.symbol),
        "2% platform fee from match"
      );
    }
  }

  /**
   * Refund escrowed funds to sender (emergency/dispute)
   * No fee deducted - full amount returned
   * Can only be called by arbiter (xprotonarena)
   */
  @Action("refund")
  refund(escrowId: u64): void {
    const config = this.getConfig();
    check(hasAuth(config.arbiter), "Only arbiter (xprotonarena) can refund");

    const escrow = this.escrowTable.get(escrowId);
    check(escrow.status == "pending", "Escrow is not in pending status");

    // Update escrow status
    escrow.status = "refunded";
    escrow.resolvedAt = currentTime();
    this.escrowTable.update(escrow, this.receiver);

    // Send full refund back to sender (no fee to treasury)
    this.sendInlineTransfer(this.receiver, escrow.sender, escrow.amount, "Escrow refund - no fee");
  }

  /**
   * Resolve a disputed escrow
   * Arbiter (xprotonarena) determines winner and applies 2% fee
   * No fee deducted on tie - players get full refund
   */
  @Action("resolve")
  resolve(escrowId: u64, winner: Name, isTie: boolean = false): void {
    const config = this.getConfig();
    check(hasAuth(config.arbiter), "Only arbiter (xprotonarena) can resolve disputes");

    const escrow = this.escrowTable.get(escrowId);
    check(escrow.status == "pending", "Escrow is not in pending status");

    if (isTie) {
      // TIE CASE: Refund both players, no fee to treasury
      this.handleTieRefund(escrow);
    } else {
      // NORMAL CASE: Deduct 2% fee and payout to winner
      this.handleWinnerPayout(escrow, winner, config);
    }

    // Update escrow status
    escrow.status = isTie ? "tied" : "resolved";
    escrow.winnerAddress = winner;
    escrow.resolvedAt = currentTime();
    escrow.isTie = isTie;
    this.escrowTable.update(escrow, this.receiver);
  }

  /**
   * Pause/unpause the contract
   * Can only be called by arbiter (xprotonarena)
   */
  @Action("setpaused")
  setpaused(paused: boolean): void {
    const config = this.getConfig();
    check(hasAuth(config.arbiter), "Only arbiter (xprotonarena) can pause/unpause");

    config.paused = paused;
    this.configTable.update(config, this.receiver);
  }

  /**
   * Update platform fee (2% = 200 basis points)
   * Fee goes to xprotonarena treasury
   * Can only be called by arbiter (xprotonarena)
   */
  @Action("setfee")
  setfee(feeInBP: u16): void {
    const config = this.getConfig();
    check(hasAuth(config.arbiter), "Only arbiter (xprotonarena) can update fees");
    check(feeInBP <= 10000, "Fee cannot exceed 100%");

    config.platformFeeBP = feeInBP;
    this.configTable.update(config, this.receiver);
  }

  /**
   * Query escrow details
   */
  @Action("getescrow")
  getescrow(escrowId: u64): void {
    const escrow = this.escrowTable.get(escrowId);
    // Return escrow data (in real implementation, this would be a view/query)
  }

  // Helper methods
  private getConfig(): Config {
    return this.configTable.get(0);
  }

  private isPaused(): boolean {
    return this.getConfig().paused;
  }

  private getNextEscrowId(): u64 {
    const last = this.escrowTable.getLast();
    return last ? last.id + 1 : 1;
  }

  private sendInlineTransfer(from: Name, to: Name, quantity: Asset, memo: string): void {
    const transfer = new Action(
      Name.fromString("eosio.token"),
      Name.fromString("transfer"),
      []
    );
    transfer.send(from, to, quantity, memo);
  }
}
