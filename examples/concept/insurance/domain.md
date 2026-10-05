# Insurance: coverage, claims and payouts

An adjuster assesses coverage as of the loss date, not today's policy. ReceiveEvidence preserves document digests and source attribution for repair estimates, medical records and police reports. AssessClaim combines evidence, fraud signals and loss-time coverage; a supervisor decision may be required before PayClaim issues several payouts. Reopening a case returns it to assessment without deleting the old decision.

MaintainClaim owns the case and reserve; approval, evidence and payment are inputs. ClaimDecision records the coverage version, evidence reference and approver needed to explain the outcome. Blobs remain external content addressed by digest. Sensitive medical evidence is disclosed only for claim assessment under the claim-team policy.
