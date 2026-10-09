# NEW-A-3 RED review record (CP1 QA, AC4)

Reviewed commit: 6eb4277 (NEW-A-3 RED tests), before NEW-A-4 implementation a046a08.

Review result, as reproduced by CP1 QA against 6eb4277 (extracted with git archive) and recorded here 2026-10-07: of 24 tests in the gemini spec, 19 fail, exit 1, each for the
stated reason ("NEW-A-4: not implemented" or the matching instanceof assertion); the 4 passing are the AC1 schema tests,
which are legitimately green against the contract; 1 is the opt-in live spec (skipped). The RED tests cover the
adapter request shape, citation pass-through, failure taxonomy mapping, timeout, and cost recording once.

Gap acknowledged: the review was not recorded at the time (a046a08 followed 6eb4277 by 6 minutes). This note records
it after the fact and says so rather than back-dating it. For the days 3-4 stories, the RED commit is made separately
and reviewed before the implementation commit starts.
