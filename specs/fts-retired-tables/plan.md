# Plan: #318 measurements

1. Rebuild the harness under `bench/issue280/` (plan rev 8, A8 Steps 1-2 and B8 Step 1).
2. Verify every leg on a 10k-row store.
3. Run the 1M legs, then gate scale by row count (4.2M) and by file size (1.333M).
4. Apply the reclamation rule (spec §2.1): bounded means no gate variant.
5. Record results in the README, this cycle's spec and an appended #280 Status revision.
6. Open the draft PR. F8 stays open for the owner.
7. After the F8 ruling: flip the Status, delete this file and `LEDGER.md`, mark the PR ready.
