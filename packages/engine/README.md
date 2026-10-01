# `@ygosim/engine`

The engine loads the Project Ignis card databases and scripts at runtime, then
uses `ocgcore-wasm` to run a duel. The card data is intentionally kept outside
the repository because it is maintained upstream.

Fetch a shallow checkout with:

```sh
scripts/fetch-data.sh
```

Set `YGOSIM_DATA` when the checkout should live elsewhere. The directory must
contain `CardScripts/` and `BabelCDB/`; card databases are loaded in this order:
`cards.cdb`, release databases, then non-Rush prerelease databases. A failed
load is retryable after the data is repaired or fetched.

`parseYdk` accepts the standard `#main`, `#extra`, and `!side` sections and
rejects unknown directives, malformed passcodes, and out-of-order sections.
Deck legality (size, card availability, and copy limits) is checked when a duel
is created.

The wrapper does not apply a format-specific ban list or enforce every
deck-file metadata convention; it checks the main/extra/side size limits, card
types, available passcodes, and three-copy identity limit. The public protocol
also intentionally compresses transient reveals and detailed battle subphases,
and unusual card effects need broader deck corpus coverage than the bundled
fixtures.

Public API (also exports the shared protocol types):

```ts
createDuel(options: DuelOptions): Promise<Duel>
loadCardDb(): Promise<CardDb>
parseYdk(text: string): Deck
```

`DuelOptions` accepts two decks, a deterministic seed, starting LP (default
8000), Master Rule 1–5 (default 5), `firstPlayer` (default 0), and
`chooseFirstTurn` for an enumerable setup choice. `Duel` implements `step`,
`respond`, `stateFor`, `redactEvents`, and idempotent `destroy`. Responses must
include the current prompt ID and option IDs; invalid responses throw before
reaching the core. Send each prompt only to its deciding player. Events from
`step()` contain authoritative identities: call `redactEvents` separately for
each recipient before sending them. `stateFor` returns an isolated snapshot.

`CardDb.get` looks up passcodes, and `search` filters names/types. Loading uses
`sql.js`, preserves packed setcodes, and resolves card effect strings from the
same database. Images use the runtime YGOPRODeck CDN URL; no images are fetched
or redistributed by this package. npm publishes the author's WASM package as
[`ocgcore-wasm`](https://github.com/n1xx1/ocgcore-wasm); the scoped
`@n1xx1/ocgcore-wasm` name belongs to JSR. The synchronous core avoids Node JSPI
flags while retaining the protocol's async API.

After fetching data, run checks from this package directory:

```sh
npm run typecheck
npm run lint
npm test
```

The tests include three complete 8000 LP duels between seeded random legal
players, plus focused data, prompt, lifecycle, and information-redaction
checks. Missing card data fails with setup instructions rather than skipping
integration coverage. The two sample decks are in `decks/`.

Snapshots preserve public identities and conceal identifying statistics along
with hidden passcodes. Hidden pile identities use viewer-specific slot IDs to
prevent following known cards through shuffles. Reveals are represented as
same-location `move` events with reason `reveal`; detailed summon subtypes are
reported as `special` because the wrapper does not expose their reason flags.
