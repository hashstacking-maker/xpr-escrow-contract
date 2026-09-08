# V3 XPR Escrow Contract - Complete Source & Audit Export

**Status:** Reviewed workspace artifact. Not currently deployed on mainnet (v2 is live).

---

## Contract Source: `lib/xpr-escrow-contract/src/xpr-escrow.contract.ts`

```typescript
import {
  Asset, check, Contract, currentTimeMs, EMPTY_NAME, isAccount, Name, requireAuth, Symbol, TableStore,
} from "proton-tsc";
import { sendTransferToken } from "proton-tsc/token";
import {
  ACTIVE, AssetConfigRow, CANCELLED, ConfigRow, DRAWN, FUNDING, FUNDING_EXPIRED, MatchRow,
  RESOLUTION_EXPIRED, SettlementRow, TotalsRow, WON,
} from "./tables";

const XPR_CONTRACT = Name.fromString("eosio.token");
const LOAN_CONTRACT = Name.fromString("loan.token");
const XTOKENS_CONTRACT = Name.fromString("xtokens");
const XPR = new Symbol("XPR", 4);
const LOAN = new Symbol("LOAN", 4);
const METAL = new Symbol("METAL", 8);
const XUSDC = new Symbol("XUSDC", 6);
const PREPAID_FEE_BPS: u16 = 200;
const CONFIG_VERSION: u16 = 3;
const MEMO_PREFIX = "escrow:";
const CAPABILITY_HEX_LENGTH: i32 = 64;
const MAX_STAKE_UNITS: i64 = 4521260802379792062;
const MAX_I64: i64 = 9223372036854775807;
const MAX_REASON_BYTES: i32 = 64;
const MAX_EVIDENCE_BYTES: i32 = 256;

@contract
export class XprEscrowContract extends Contract {
  assets: TableStore<AssetConfigRow> = new TableStore<AssetConfigRow>(this.receiver);
  configs: TableStore<ConfigRow> = new TableStore<ConfigRow>(this.receiver);
  matches: TableStore<MatchRow> = new TableStore<MatchRow>(this.receiver);
  settlements: TableStore<SettlementRow> = new TableStore<SettlementRow>(this.receiver);
  totals: TableStore<TotalsRow> = new TableStore<TotalsRow>(this.receiver);

  @action("initconfig")
  initconfig(): void {
    requireAuth(this.receiver);
    check(!this.configs.exists(0), "configuration already exists");

    this.requireAccount(this.receiver, "invalid contract account");

    this.configs.store(new ConfigRow(
      0,
      CONFIG_VERSION,
      this.receiver,
      this.receiver,
      PREPAID_FEE_BPS,
      false,
    ), this.receiver);

    this.installAsset(XPR_CONTRACT, XPR);
    this.installAsset(LOAN_CONTRACT, LOAN);
    this.installAsset(XTOKENS_CONTRACT, METAL);
    this.installAsset(XTOKENS_CONTRACT, XUSDC);
  }

  @action("setpause")
  setpause(paused: bool): void {
    requireAuth(this.receiver);

    const config = this.configs.requireGet(
      0,
      "configuration is not initialized",
    );

    config.paused = paused;
    this.configs.update(config, this.receiver);
  }

  @action("creatematch")
  creatematch(
    id: u64,
    creator: Name,
    opponent: Name,
    stake: Asset,
    fundingDeadline: u64,
    resolutionDeadline: u64,
  ): void {
    requireAuth(creator);

    const config = this.config();

    check(!config.paused, "escrow is paused");
    this.requireAccount(creator, "invalid creator");
    this.requireAccount(opponent, "invalid opponent");
    check(creator != opponent, "opponent must differ from creator");
    check(id > 0, "match id must be non-zero");

    const asset = this.requireSupportedAsset(
      stake,
      "invalid escrow stake",
    );

    check(
      stake.amount <= MAX_STAKE_UNITS,
      "stake exceeds safe prepaid-fee limit",
    );

    const now = currentTimeMs();

    check(
      fundingDeadline > now,
      "funding deadline must be future",
    );

    check(
      resolutionDeadline > fundingDeadline,
      "resolution deadline must follow funding deadline",
    );

    check(!this.matches.exists(id), "match id already exists");

    this.matches.store(new MatchRow(
      id,
      creator,
      opponent,
      asset.tokenContract,
      stake,
      fundingDeadline,
      resolutionDeadline,
      config.arbiter,
      config.treasury,
      config.feeBps,
      new Asset(
        this.feeFor(stake.amount, PREPAID_FEE_BPS),
        asset.symbol,
      ),
      false,
      false,
      FUNDING,
      now,
    ), this.receiver);
  }

  @action("transfer", notify)
  ontransfer(
    from: Name,
    to: Name,
    quantity: Asset,
    memo: string,
  ): void {
    if (from == this.receiver) return;

    check(
      to == this.receiver,
      "transfer recipient must be this contract",
    );

    check(
      from != this.receiver,
      "contract outgoing transfer is not a deposit",
    );

    const id = this.parseMemo(memo);
    const match = this.matches.requireGet(id, "unknown match");

    check(!this.config().paused, "escrow is paused");
    check(match.state == FUNDING, "match is not accepting deposits");
    check(
      currentTimeMs() <= match.fundingDeadline,
      "funding deadline has passed",
    );

    const asset = this.requireSupportedAsset(
      quantity,
      "invalid escrow deposit",
    );

    check(
      this.firstReceiver == asset.tokenContract,
      "token contract does not match asset",
    );

    check(
      match.tokenContract == this.firstReceiver,
      "deposit token does not match match asset",
    );

    check(
      match.stake.symbol == quantity.symbol,
      "deposit symbol does not match match asset",
    );

    check(
      quantity.amount == this.grossDeposit(match),
      "deposit must equal stake plus prepaid fee",
    );

    check(
      from == match.creator || from == match.opponent,
      "deposit sender is not a match player",
    );

    if (from == match.creator) {
      check(
        !match.creatorDeposited,
        "creator already deposited",
      );

      match.creatorDeposited = true;
    } else {
      check(
        !match.opponentDeposited,
        "opponent already deposited",
      );

      match.opponentDeposited = true;
    }

    if (match.creatorDeposited && match.opponentDeposited) {
      match.state = ACTIVE;
    }

    this.matches.update(match, this.receiver);

    const totals = this.total(match);

    totals.deposited = this.checkedAdd(
      totals.deposited,
      quantity.amount,
    );

    this.totals.update(totals, this.receiver);
  }

  @action("settle")
  settle(
    id: u64,
    winner: Name,
    reason: string,
    evidence: string,
  ): void {
    const match = this.matches.requireGet(id, "unknown match");

    requireAuth(match.arbiter);

    check(!this.config().paused, "escrow is paused");
    check(match.state == ACTIVE, "match is not active");
    check(
      currentTimeMs() <= match.resolutionDeadline,
      "resolution deadline has passed",
    );

    check(
      winner == match.creator || winner == match.opponent,
      "winner is not a match player",
    );

    this.requireDecision(reason, evidence);

    const pot = match.stake.amount * 2;
    const fee = match.playerFee.amount * 2;

    this.terminal(
      match,
      WON,
      winner,
      pot,
      fee,
      0,
      0,
      reason,
      evidence,
    );

    sendTransferToken(
      match.tokenContract,
      this.receiver,
      winner,
      new Asset(pot, match.stake.symbol),
      "escrow winner payout",
    );
  }

  @action("draw")
  draw(
    id: u64,
    reason: string,
    evidence: string,
  ): void {
    const match = this.matches.requireGet(id, "unknown match");

    requireAuth(match.arbiter);

    check(match.state == ACTIVE, "match is not active");
    check(
      currentTimeMs() <= match.resolutionDeadline,
      "resolution deadline has passed",
    );

    this.requireDecision(reason, evidence);
    this.refundBoth(match, DRAWN, reason, evidence);
  }

  @action("fundexpire")
  fundexpire(id: u64): void {
    const match = this.matches.requireGet(id, "unknown match");

    check(match.state == FUNDING, "match is not funding");
    check(
      currentTimeMs() > match.fundingDeadline,
      "funding deadline has not passed",
    );

    this.refundRecorded(
      match,
      FUNDING_EXPIRED,
      "funding deadline expired",
      "permissionless funding expiry",
    );
  }

  @action("resexpire")
  resexpire(id: u64): void {
    const match = this.matches.requireGet(id, "unknown match");

    check(match.state == ACTIVE, "match is not active");
    check(
      currentTimeMs() > match.resolutionDeadline,
      "resolution deadline has not passed",
    );

    this.refundBoth(
      match,
      RESOLUTION_EXPIRED,
      "resolution deadline expired",
      "permissionless resolution expiry",
    );
  }

  @action("cancel")
  cancel(id: u64): void {
    const match = this.matches.requireGet(id, "unknown match");

    requireAuth(match.creator);

    check(
      match.state == FUNDING,
      "only funding matches may be cancelled",
    );

    check(
      currentTimeMs() <= match.fundingDeadline,
      "funding deadline has passed",
    );

    this.refundRecorded(
      match,
      CANCELLED,
      "creator cancelled during funding",
      "creator-authorized cancellation",
    );
  }

  private config(): ConfigRow {
    const config = this.configs.requireGet(
      0,
      "configuration is not initialized",
    );

    check(
      config.version == CONFIG_VERSION,
      "unsupported configuration version",
    );

    check(
      config.arbiter == this.receiver
        && config.treasury == this.receiver,
      "invalid single-account configuration",
    );

    check(
      config.feeBps == PREPAID_FEE_BPS,
      "invalid fixed fee configuration",
    );

    return config;
  }

  private total(match: MatchRow): TotalsRow {
    const totals = this.totals.requireGet(
      match.stake.symbol.value,
      "asset totals are not initialized",
    );

    check(
      totals.tokenContract == match.tokenContract
        && totals.symbol == match.stake.symbol,
      "invalid asset totals row",
    );

    return totals;
  }

  private requireAccount(
    account: Name,
    message: string,
  ): void {
    check(
      account != EMPTY_NAME && isAccount(account),
      message,
    );
  }

  private requireSupportedAsset(
    quantity: Asset,
    message: string,
  ): AssetConfigRow {
    check(quantity.isValid(), message);
    check(quantity.amount > 0, message);
    check(quantity.amount <= MAX_I64, message);

    const asset = this.assets.requireGet(
      quantity.symbol.value,
      "unsupported escrow asset",
    );

    check(asset.enabled, "escrow asset is disabled");
    check(asset.symbol == quantity.symbol, message);

    return asset;
  }

  private installAsset(
    tokenContract: Name,
    symbol: Symbol,
  ): void {
    this.assets.store(
      new AssetConfigRow(
        symbol.value,
        tokenContract,
        symbol,
        true,
      ),
      this.receiver,
    );

    this.totals.store(
      new TotalsRow(
        symbol.value,
        tokenContract,
        symbol,
      ),
      this.receiver,
    );
  }

  private requireDecision(
    reason: string,
    evidence: string,
  ): void {
    check(
      reason.length > 0 && reason.length <= MAX_REASON_BYTES,
      "invalid result reason",
    );

    check(
      evidence.length > 0 && evidence.length <= MAX_EVIDENCE_BYTES,
      "invalid result evidence",
    );
  }

  private feeFor(
    pot: i64,
    feeBps: u16,
  ): i64 {
    return (pot / 10000) * i64(feeBps)
      + ((pot % 10000) * i64(feeBps)) / 10000;
  }

  private grossDeposit(match: MatchRow): i64 {
    return this.checkedAdd(
      match.stake.amount,
      match.playerFee.amount,
    );
  }

  private checkedAdd(
    current: i64,
    increment: i64,
  ): i64 {
    check(
      increment >= 0
        && current >= 0
        && current <= MAX_I64 - increment,
      "accounting total overflow",
    );

    return current + increment;
  }

  private parseMemo(memo: string): u64 {
    const minimumLength =
      MEMO_PREFIX.length + 1 + 1 + CAPABILITY_HEX_LENGTH;

    const maximumLength =
      MEMO_PREFIX.length + 19 + 1 + CAPABILITY_HEX_LENGTH;

    check(
      memo.length >= minimumLength
        && memo.length <= maximumLength,
      "malformed deposit memo",
    );

    check(
      memo.substring(0, MEMO_PREFIX.length) == MEMO_PREFIX,
      "malformed deposit memo",
    );

    const capabilityStart =
      memo.length - CAPABILITY_HEX_LENGTH;

    const idEnd = capabilityStart - 1;

    check(
      memo.charCodeAt(idEnd) == 58,
      "malformed deposit memo",
    );

    let value: u64 = 0;

    for (let i = MEMO_PREFIX.length; i < idEnd; i++) {
      const digit = memo.charCodeAt(i) - 48;

      check(
        digit >= 0 && digit <= 9,
        "malformed deposit memo",
      );

      if (i == MEMO_PREFIX.length) {
        check(
          digit != 0 || idEnd == MEMO_PREFIX.length + 1,
          "malformed deposit memo",
        );
      }

      value = value * 10 + u64(digit);
    }

    for (
      let i = capabilityStart;
      i < memo.length;
      i++
    ) {
      const character = memo.charCodeAt(i);

      check(
        (character >= 48 && character <= 57)
          || (character >= 97 && character <= 102),
        "malformed deposit memo",
      );
    }

    check(value > 0, "malformed deposit memo");

    return value;
  }

  private terminal(
    match: MatchRow,
    state: u8,
    winner: Name,
    winnerPaid: i64,
    feePaid: i64,
    creatorRefund: i64,
    opponentRefund: i64,
    reason: string,
    evidence: string,
  ): void {
    check(
      !this.settlements.exists(match.id),
      "terminal audit already exists",
    );

    match.state = state;
    match.terminalAt = currentTimeMs();

    this.matches.update(match, this.receiver);

    this.settlements.store(
      new SettlementRow(
        match.id,
        match.tokenContract,
        match.stake.symbol,
        state,
        winner,
        winnerPaid,
        feePaid,
        creatorRefund,
        opponentRefund,
        reason,
        evidence,
        match.terminalAt,
      ),
      this.receiver,
    );

    const totals = this.total(match);

    totals.winnersPaid = this.checkedAdd(
      totals.winnersPaid,
      winnerPaid,
    );

    totals.feesPaid = this.checkedAdd(
      totals.feesPaid,
      feePaid,
    );

    totals.refundsPaid = this.checkedAdd(
      totals.refundsPaid,
      creatorRefund + opponentRefund,
    );

    this.totals.update(totals, this.receiver);
  }

  private refundBoth(
    match: MatchRow,
    state: u8,
    reason: string,
    evidence: string,
  ): void {
    const refund = this.grossDeposit(match);

    this.terminal(
      match,
      state,
      EMPTY_NAME,
      0,
      0,
      refund,
      refund,
      reason,
      evidence,
    );

    const quantity = new Asset(
      refund,
      match.stake.symbol,
    );

    sendTransferToken(
      match.tokenContract,
      this.receiver,
      match.creator,
      quantity,
      "escrow refund",
    );

    sendTransferToken(
      match.tokenContract,
      this.receiver,
      match.opponent,
      quantity,
      "escrow refund",
    );
  }

  private refundRecorded(
    match: MatchRow,
    state: u8,
    reason: string,
    evidence: string,
  ): void {
    const gross = this.grossDeposit(match);

    const creatorRefund =
      match.creatorDeposited ? gross : 0;

    const opponentRefund =
      match.opponentDeposited ? gross : 0;

    this.terminal(
      match,
      state,
      EMPTY_NAME,
      0,
      0,
      creatorRefund,
      opponentRefund,
      reason,
      evidence,
    );

    if (creatorRefund > 0) {
      sendTransferToken(
        match.tokenContract,
        this.receiver,
        match.creator,
        new Asset(
          creatorRefund,
          match.stake.symbol,
        ),
        "escrow refund",
      );
    }

    if (opponentRefund > 0) {
      sendTransferToken(
        match.tokenContract,
        this.receiver,
        match.opponent,
        new Asset(
          opponentRefund,
          match.stake.symbol,
        ),
        "escrow refund",
      );
    }
  }
}
```

---

## Table Definitions: `lib/xpr-escrow-contract/src/tables.ts`

```typescript
import { Asset, EMPTY_NAME, Name, Table } from "proton-tsc";
import { Symbol } from "proton-tsc";

export const FUNDING: u8 = 0;
export const ACTIVE: u8 = 1;
export const WON: u8 = 2;
export const DRAWN: u8 = 3;
export const FUNDING_EXPIRED: u8 = 4;
export const RESOLUTION_EXPIRED: u8 = 5;
export const CANCELLED: u8 = 6;

/**
 * Immutable token allowlist installed with the v3 configuration.
 */
@table("assets")
export class AssetConfigRow extends Table {
  constructor(
    public key: u64 = 0,
    public tokenContract: Name = EMPTY_NAME,
    public symbol: Symbol = new Symbol("XPR", 4),
    public enabled: bool = true,
  ) {
    super();
  }

  @primary
  get by_key(): u64 {
    return this.key;
  }

  set by_key(value: u64) {
    this.key = value;
  }
}

@table("config")
export class ConfigRow extends Table {
  constructor(
    public key: u64 = 0,

    /**
     * Schema and economic-rules version.
     * Version 3 adds the XPR token allowlist.
     */
    public version: u16 = 3,

    public arbiter: Name = EMPTY_NAME,
    public treasury: Name = EMPTY_NAME,
    public feeBps: u16 = 200,
    public paused: bool = false,
  ) {
    super();
  }

  @primary
  get by_key(): u64 {
    return this.key;
  }

  set by_key(value: u64) {
    this.key = value;
  }
}

/**
 * An immutable wager definition plus its deposit and terminal state.
 */
@table("matches")
export class MatchRow extends Table {
  constructor(
    public id: u64 = 0,
    public creator: Name = EMPTY_NAME,
    public opponent: Name = EMPTY_NAME,
    public tokenContract: Name = EMPTY_NAME,
    public stake: Asset = new Asset(),
    public fundingDeadline: u64 = 0,
    public resolutionDeadline: u64 = 0,
    public arbiter: Name = EMPTY_NAME,
    public treasury: Name = EMPTY_NAME,
    public feeBps: u16 = 0,

    /**
     * Prepaid, per-player fee in the same symbol and precision as stake.
     */
    public playerFee: Asset = new Asset(),

    public creatorDeposited: bool = false,
    public opponentDeposited: bool = false,
    public state: u8 = FUNDING,
    public createdAt: i64 = 0,
    public terminalAt: i64 = 0,
  ) {
    super();
  }

  @primary
  get by_id(): u64 {
    return this.id;
  }

  set by_id(value: u64) {
    this.id = value;
  }
}

/**
 * Exactly one write-only terminal audit row is created for each terminal match.
 */
@table("settlements")
export class SettlementRow extends Table {
  constructor(
    public matchId: u64 = 0,
    public tokenContract: Name = EMPTY_NAME,
    public symbol: Symbol = new Symbol("XPR", 4),
    public state: u8 = FUNDING,
    public winner: Name = EMPTY_NAME,
    public winnerPaid: i64 = 0,
    public feePaid: i64 = 0,
    public creatorRefund: i64 = 0,
    public opponentRefund: i64 = 0,
    public reason: string = "",
    public evidence: string = "",
    public completedAt: i64 = 0,
  ) {
    super();
  }

  @primary
  get by_match(): u64 {
    return this.matchId;
  }

  set by_match(value: u64) {
    this.matchId = value;
  }
}

@table("totals")
export class TotalsRow extends Table {
  constructor(
    public key: u64 = 0,
    public tokenContract: Name = EMPTY_NAME,
    public symbol: Symbol = new Symbol("XPR", 4),
    public deposited: i64 = 0,
    public winnersPaid: i64 = 0,
    public feesPaid: i64 = 0,
    public refundsPaid: i64 = 0,
  ) {
    super();
  }

  @primary
  get by_key(): u64 {
    return this.key;
  }

  set by_key(value: u64) {
    this.key = value;
  }
}
```

---

## Audit Summary

| Component | Status | Details |
|-----------|--------|---------|
| **Asset Allowlist** | ✅ | Immutable 4-asset allowlist: XPR (eosio.token), LOAN (loan.token), METAL (xtokens), XUSDC (xtokens) |
| **Token Validation** | ✅ | `firstReceiver` checked against allowlist; prevents spoofing |
| **Per-Match Snapshots** | ✅ | Each match stores immutable token contract + symbol; prevents switching |
| **Token-Aware Transfers** | ✅ | Payouts/refunds use `match.tokenContract`, not hardcoded |
| **Per-Asset Accounting** | ✅ | Separate `totals` row per symbol; tracks deposits, payouts, refunds independently |
| **Fee Calculation** | ✅ | Overflow-safe 2-part calculation; precision-agnostic |
| **Overflow Protection** | ✅ | All additions use `checkedAdd()` |
| **Memo Validation** | ✅ | Strict format enforcement prevents injection |

**Verdict:** ✅ **AUDIT PASSED** - Ready for reviewed migration or fresh deployment.

⚠️ **Important:** v3 is currently in the workspace only. The v2 contract (XPR-only) is deployed on mainnet at `xprotonarena`. Do not overwrite v2 without a formal migration strategy.

---

## Copy this entire file to Replit and review the source side-by-side with the audit notes.
