# Anchor Token Test Results

**Date:** 2025-11-22
**Test Data:** `Capture_Data/capture_1763842540750/`

## Test Setup

**Algorithm:** Rolling average voting
- For each generation step: calculate local mean attention
- Award +1 vote to tokens above local mean
- Sum votes across all generation steps
- Group by (turn_id, sentence_id), take peak vote of any token in sentence

**Data:**
- 1,703 prompt tokens
- 326 generation steps analyzed
- 82 sentences total (sentence_id resets per turn)
- All attention data normalized (no race condition)

## Results

**Sentence distribution by peak votes:**

- Peak = 0: 59 sentences (72.0%)
- Peak > 0: 23 sentences (28.0%)

**Top 10 anchor tokens:**

| Position | Token | Votes | Vote % |
|----------|-------|-------|--------|
| 0 | ? | 293 | 100.0% |
| 102 | Mull | 272 | 92.8% |
| 127 | proposed | 260 | 88.7% |
| 101 | Joe | 258 | 88.1% |
| 10 | participating | 244 | 83.3% |
| 4 | are | 236 | 80.5% |
| 68 | ( | 209 | 71.3% |
| 16 | attention | 203 | 69.3% |
| 24 | , | 202 | 68.9% |
| 199 | defend | 188 | 64.2% |

## The 23 Sentences With Peak > 0

(Shown in original order from the prompt)

---

**Turn 0, Sentence 0** (Peak: 326 votes, 20 tokens)
```
system
You are Qwen, an AI participating in a research project on attention-based context management
```

**Turn 0, Sentence 1** (Peak: 213 votes, 9 tokens)
```
. You are helpful, harmless, and honest
```

**Turn 0, Sentence 2** (Peak: 13 votes, 3 tokens)
```
.

```

**Turn 1, Sentence 0** (Peak: 140 votes, 11 tokens)
```
user
What are the implications of the following article
```

**Turn 1, Sentence 1** (Peak: 177 votes, 19 tokens)
```
?

The Patent Office Is About To Make Bad Patents Untouchable
The U.S
```

**Turn 1, Sentence 2** (Peak: 217 votes, 33 tokens)
```
. Patent and Trademark Office (USPTO) has proposed new rules that would effectively end the public's ability to challenge improperly granted patents at the Patent Office itself
```

**Turn 1, Sentence 3** (Peak: 305 votes, 12 tokens)
```
. We need EFF

By Joe Mullin

6 min
```

**Turn 1, Sentence 4** (Peak: 174 votes, 8 tokens)
```
. readView original
The U.S
```

**Turn 1, Sentence 5** (Peak: 289 votes, 35 tokens)
```
. Patent and Trademark Office (USPTO) has proposed new rules that would effectively end the public's ability to challenge improperly granted patents at their source—the Patent Office itself
```

**Turn 1, Sentence 6** (Peak: 218 votes, 32 tokens)
```
. If these rules take effect, they will hand patent trolls exactly what they've been chasing for years: a way to keep bad patents alive and out of reach
```

**Turn 1, Sentence 7** (Peak: 215 votes, 19 tokens)
```
. People targeted with troll lawsuits will be left with almost no realistic or affordable way to defend themselves
```

**Turn 1, Sentence 8** (Peak: 128 votes, 14 tokens)
```
.

We need EFF supporters to file public comments opposing these rules right away
```

**Turn 1, Sentence 9** (Peak: 183 votes, 10 tokens)
```
. The deadline for public comments is December 2
```

**Turn 1, Sentence 10** (Peak: 187 votes, 21 tokens)
```
. The USPTO is moving quickly, and staying silent will only help those who profit from abusive patents
```

**Turn 1, Sentence 11** (Peak: 142 votes, 43 tokens)
```
.

TAKE ACTION

Tell USPTO: The public has a right to challenge bad patents

We're asking supporters who care about a fair patent system to file comments using the federal government's public comment system
```

**Turn 1, Sentence 12** (Peak: 103 votes, 16 tokens)
```
. Your comments don't need to be long, or use legal or technical vocabulary
```

**Turn 1, Sentence 13** (Peak: 79 votes, 23 tokens)
```
. The important thing is that everyday users and creators of technology have  the chance to speak up, and be counted
```

**Turn 1, Sentence 14** (Peak: 68 votes, 14 tokens)
```
.

Below is a short, simple comment you can copy and paste
```

**Turn 1, Sentence 15** (Peak: 72 votes, 18 tokens)
```
. Your comment will carry more weight if you add a personal sentence or two of your own
```

**Turn 1, Sentence 16** (Peak: 49 votes, 20 tokens)
```
. Please note that comments should be submitted under your real name and will become part of the public record
```

**Turn 1, Sentence 17** (Peak: 45 votes, 27 tokens)
```
.

Sample comment:

I oppose the USPTO's proposed rule changes for inter partes review (IPR), Docket No
```

**Turn 1, Sentence 18** (Peak: 20 votes, 14 tokens)
```
. PTO-P-2025-0025
```

**Turn 1, Sentence 19** (Peak: 7 votes, 10 tokens)
```
. The IPR process must remain open and fair
```

---

## Token Count

**Total tokens in 23 sentences:** 421 tokens
**Total tokens in original prompt:** 1,703 tokens
**Percentage retained:** 24.7%

## What Was Not Included (59 sentences with peak = 0)

These sentences were never referenced above local mean during generation. They include:
- Explanations of what IPR is
- Three case examples (EFF crowdsourcing, SportBrain patent, Shipping & Transit)
- Detailed descriptions of how the rules work
- Historical context about patent trolling
- Multiple repetitions and elaborations of the same points

**Total tokens in 59 sentences:** ~1,282 tokens (75.3% of original)

## Summary

- One test run with 1,703 token prompt
- 326 generation steps captured
- Algorithm separated 82 sentences into two groups: 59 with peak=0, 23 with peak>0
- The 23 sentences with peak>0 contain 421 tokens (24.7% of original)
- Bug fixed: sentence_id resets per turn, must group by (turn_id, sentence_id)
