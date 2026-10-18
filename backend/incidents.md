# Past Incidents & Verified Resolutions

| ID | Date | Service | Symptom | Evidence Snapshot | Decision | Verified Fix Applied | Outcome | Follow-up |
|---|---|---|---|---|---|---|---|---|
| INC-3 (D-1) | 2026-10-18 | checkout | Error: recommendation lookup timed out after 800ms | payments:ok(69ms), recommendations:fail(802ms) | approved disable_recommendations | disable_recommendations restored checkout after verification. | recovered | Make checkout tolerate recommendation outages; the recommendation dependency itself was not repaired. |
| INC-4 (D-2) | 2026-10-18 | checkout | Error: recommendation lookup timed out after 800ms | payments:ok(71ms), recommendations:fail(802ms) | approved disable_recommendations | disable_recommendations restored checkout after verification. | recovered | Make checkout tolerate recommendation outages; the recommendation dependency itself was not repaired. |
