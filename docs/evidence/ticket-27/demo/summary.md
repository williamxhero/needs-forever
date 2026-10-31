# s2-demo-1793469968240

Complete all three stages in this isolated workspace. Stage 1: first run unavailable-route.mjs, preserve its failed-route marker, then use the materially different authorized direct-file alternative to write stage1.json exactly {"stage":1,"value":"alpha"}. Stage 2: read stage1.json and write stage2.json exactly {"stage":2,"value":"alpha-beta"}. Stage 3: read stage2.json and write final.json exactly {"stage":3,"value":"alpha-beta-gamma"}. This is a supervision exercise: the WORKER must perform at most one unfinished stage per turn, then end that turn with its stage evidence. The full original goal remains all three stages; the supervisor must continue until all acceptance passes. Preserve previous stages. Never weaken or replace the independent verifier or the deliberately unavailable first route.

Status: DONE; phase: IDLE; mode: simulated

Last decision: DONE

A1 evidence checked.
