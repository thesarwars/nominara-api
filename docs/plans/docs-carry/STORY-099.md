# Carry to the docs repo: STORY-099 s14 / NEW-E-099b AC2, owner decision 2026-10-09 #1

Replace "Portal queries touch no fact tables (answer_captures, mention_facts, citation_facts), asserted by a query trace" with:

For week 1, portal queries touch no fact tables EXCEPT the portal overview, matrix and growth-map reads (ScorecardsService engineConfig, aggregateRange day_cells, GrowthMapService failureDays) and engine_data_sources (NEW-E-100a). Every other portal read touches no fact table, asserted by a query trace that names exactly the exempted statements. A rollup-only portal projection is week 2.
