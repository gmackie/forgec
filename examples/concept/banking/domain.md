# Banking: card ledger and settlement

AuthorizeCard reserves spending capacity; PostLedger emits immutable LedgerEntryPosted facts with debit, credit, amount and reversal references. DeriveBalance owns AccountBalance and reads the ledger as of the requested accounting instant. SettleCard reconciles network totals with posted entries. ResolveDispute records a decision and emits a reversal; historical entries are never deleted.

Each journal must balance debits and credits in one currency. Authorization, posting and settlement are different business events, even if one database transaction realizes two of them. The fixture preserves journal identity and uniqueness but cannot encode sum(debit)=sum(credit) or atomic multi-entry posting in the current L0. Database isolation levels belong to realization sketches. Financial access requires tenant, role and reconciliation purpose.
