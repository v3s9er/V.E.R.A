# Scoped ontology and measured application behavior

Mr.Robot now has a **bounded ontology rule engine**, not just subject/predicate/object
search. It is not an OWL reasoner, SHACL implementation, learned model, or proof
that model answers are correct.

## What runs

The authenticated `chat.start` handler selects personal/project/conversation facts
under the existing scope boundary. Relevant facts and connected relations are
retrieved, deterministic rules run locally, and a compact evidence packet reaches
both ordinary execution and the council. No additional model call is needed for
this step. Isolated Discord runs skip private knowledge entirely.

| Relation | Behavior |
| --- | --- |
| `is_a` + `subclass_of` | Inherit types along the declared class hierarchy |
| `subclass_of`, `part_of`, `depends_on` | Bounded transitive closure; cycles flagged |
| `located_in`, `owner`, `status` | Different current values are unresolved conflicts |
| `requires` | Multiple values coexist |
| `disjoint_with` | Conflicting asserted/inherited types are flagged |
| Other predicates | Stored/searchable claims, no invented inference rules |

Facts keep source IDs. Deductions carry the premise IDs and rule names, not a
made-up confidence score. Missing facts mean unknown, not false. A contradiction
does not authorize choosing the newest value. Conflicted deductions remain
unresolved. No rule grants execution/file/network privileges or mutates settings.
The shape-validation versus inference distinction follows the separation discussed
in [W3C SHACL](https://www.w3.org/TR/shacl/); this implementation claims no W3C
conformance and supports only the explicit vocabulary above.

## User controls and compatibility

In desktop/web Settings → Memory → Project knowledge, choose a scope, subject,
relation, value and source. The new default adds a separate assertion. To correct
a fact, explicitly select the existing value to replace. Inspect related knowledge
to see deductions and unresolved conflicts in readable form. Existing memory
deletion remains available. The same web form uses the existing responsive grid;
the separate native mobile application has no new ontology editor in this change.

Older RPC clients that omit `relationMode: "fact"` keep their legacy same-slot
replacement behavior. Old superseded values are not silently resurrected. New
assertions do not overwrite one another. Explicit corrections require the same
project, conversation, subject and predicate as the active original.

The engine does not automatically scrape chats, import private documents, persist
model guesses, rewrite an uploaded source, or convert AGENTS.md instructions into
facts. Users must save the general knowledge they want retained. Image character-reading
errors are a separate problem; ontology does not fix pixels it has not observed.

## Project work integration (0.6.9)

For a selected local npm project, the app reads `package.json` and supported
workspace package manifests on each request. It derives ephemeral `located_in`,
`part_of` and internal `depends_on` assertions from package names and dependency
keys. Sources include the relative manifest path and SHA-256. Dependency values,
scripts, environment files and document contents are not added to the graph.
These are declarations, not proof of runtime behavior: optional/development/peer
dependencies indicate potential change impact, and common membership alone does
not prove dependency. Other ecosystems still need explicitly saved facts.

The reader is bounded to 64 manifests of 128 KiB each and 256 directory entries.
Only literal workspace paths and a trailing `/*` are supported; unsupported globs,
invalid files and truncated reads are marked partial. Paths stay under the
selected project; symlinks/junctions, hardlinked manifests and observed file
identity changes are rejected. No package scripts run. Observations remain in
memory for the request and never overwrite the user's saved claims. Contradictory
saved locations remain unresolved. The knowledge inspector includes these
declarations when a project is selected.

An explicit referential follow-up such as “그거 바꾸면?” may use the immediately
previous user request as a bounded retrieval hint when the current query has no
match. It never mines assistant guesses or loads the entire conversation graph.
New unrelated questions and greetings do not trigger that fallback.

The host-only `knowledge_lookup` tool lets the normal API/native main agent query
another entity during work, within the same project/conversation scope. It refreshes
manifest observations when invoked, validates query-only input and permits at most
six lookups per run. It cannot change scope, save facts or grant access. Native
read-only execution may use it; isolated Discord execution never receives private
knowledge or this callback. Simple replies remain tool-free, and text-only models
are not switched to another provider just to obtain the tool.

Initial telemetry counts describe the initial injected graph, not the cumulative
results of later lookups. Ordinary tool events record later lookups. Additional
context has an input-token cost; usefulness and latency must be measured.

## Bounds and observability

- At most 2,048 scoped active assertions considered, 24 relevant seeds, 128
  connected assertions, six retrieval hops, eight closure rounds and 512 facts.
- Deductions retain at most 24 source premises; 64 conflict details returned.
- A 7,000-byte proof packet and approximately 4,000-byte plain-memory packet.
  Source IDs/text are emitted once and reused by short references. Partial graph
  or prompt results are explicitly labelled; they are not closed-world answers.
- A 24-entry bounded query cache is invalidated on memory writes/deletes. Returns
  are defensive copies. No new background timers, network services or databases.
- Candidates are tokenized once per query and ranking scores reused. Korean
  particle forms keep the original token and an additional stem; entity IDs are
  never merged or rewritten. Cache-hit timing reflects the current lookup.
- Private telemetry records counts, bytes, retrieval duration and truncation, not
  fact/provenance bodies. Counts describe the selected graph, which may exceed the
  rendered subset under the prompt budget. The UI reports unresolved conflicts.

## Evaluation contract

Rule/isolation tests are deterministic software tests, not an LLM accuracy score.
Live comparisons use the installed application, the exact same `gpt-6-sol` model,
medium reasoning, Daybreak off and unchanged permissions. Single/ontology/council/
combined runs use fresh conversations and equal user-visible givens. Additional
knowledge context has an actual token cost and must be counted.

The new synthetic suite is a functional comparison, not an independent public
benchmark or a claim about unseen contest performance. Two executions per arm,
with reverse order on the second pass, are only preliminary observations. This
distinction follows [OpenAI's evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices): task-specific checks and repeated
measurement precede broad performance claims. Raw reports remain private under
`release/validation`; previous failed contest runs are not overwritten.
