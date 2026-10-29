---
name: uk-legislation-guide
description: Decide with the uklaw_* tools whether a UK provision is in force and current, what it said on a date, what amended or commenced it, and what changed since a date. Use when a task needs UK, Scottish, Welsh, Northern Ireland or retained EU legislation from legislation.gov.uk, or when interpreting revised text, editorial status, effects, or Publication Log events.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

The statute book on legislation.gov.uk: original (enacted or made) text, revised text with point-in-time versions, recorded effects, and the Publication Log. Keyless.

- Not held: case law (The National Archives' Find Case Law service), explanatory notes, impact assessments, and Bills. The draft types are draft statutory instruments, which are not law.
- An `eur` item's current text is UK law: the EU instrument as it stood on 31 December 2020 plus later UK amendments (`eur/2016/679` is the UK GDPR). For the text in force in the EU, pair with an EUR-Lex server.
- "Scottish legislation" (or Welsh, or Northern Ireland) has two readings. Legislation made there is a type filter: Scotland `asp`, `ssi`, `aosp`; Wales `asc`, `anaw`, `mwa`, `wsi`; Northern Ireland `nia`, `mnia`, `apni`, `nisi` (Orders in Council), `nisr`, `nisro`; `uklaw_list_reference` types lists them all, drafts included. UK legislation that forms part of the law there is the extent filter. Ask which the user means when the answers differ.

## Identifiers

| Identifier | Comes from | Note |
|:--|:--|:--|
| Item path | `uklaw_lookup_citation` for a known citation or title, `uklaw_search_legislation` for a topic | A pre-1963 Act resolves to a regnal path (`ukpga/Geo5/15-16/20`) with no year; `uklaw_get_document` reports `item.year`, and `uklaw_get_amendments` takes the calendar form `ukpga/1925/20`. `uklaw_get_document` reads either form and reports the regnal path as `item.path`, with a notice, as it does `wsi` for a Welsh SI passed as `uksi`; a calendar path two sessions share (`ukpga/1955/19`) fails `ambiguous_item` naming both regnal paths |
| Provision path | `provision_path` from the lookup, an item outline, or a `match_text` outline | A section's path does not nest under its Part: `section/65`, not `part/3/section/65` |
| Identifier URI | Annotation `citations[].uri`, effect `provisions[].uri` | Pass it to `uklaw_get_document` as `item` unchanged; the provision is split out of it |
| Version date | `version.available` on any read | Dates at which a version of that document is held; a dated read can serve one the list omitted, and then lists it |

## Gates

**In force is not the same as present in the revised text.** Read `provision.status` first: `Prospective` means not in force at that version, and the text is still shown (Equality Act 2010 s. 14). An unmarked status does not mean wholly in force. The `I` (commencement) annotations say from when, for where, and for what purposes: Equality Act 2010 s. 1 carries no status and extent E+W+S, but its only `I` annotations commence subsections of it for Scotland and, for specified purposes, for Wales. Report those qualifications as written; extent says where a provision is law, not where it is in force.

**Outstanding effects say whether revised text is behind.** For each outstanding effect touching the provision, compare its `in_force` entries with the date that matters: `prospective` (no date) or a date after it means the change is not yet in force, so the text is right for that date; a date on or before it means the revised text has not caught up, and the effect's affecting provision holds the change. An unapplied effect with `requires_applied: false` needs no text change; its `notes` say why.

**A provision read lists effects on its enclosing provisions; a provision filter does not.** An effect on a heading names the enclosing cross-heading or Part, not the provision: Civil Procedure Rules (`uksi/1998/3132`) "rule 77.3 heading" names `part/77/crossheading/1`. A `rule/77.3` read lists it, and a container read lists the effects on the provisions it renders, but a `uklaw_get_amendments` `provision` filter matches only effects naming that path: pass the enclosing path, or list the item's effects with no provision. When the check could not run, the read says so in a notice that names the `uklaw_get_amendments` call, and its caveat says effects on those provisions were not checked rather than that none are outstanding.

**A provision-filtered effects list is complete only when `has_more` is false.** Each call scans at most 1,500 of the item's effects (`scan` reports how many of `total_effects`); a heavily amended Act holds thousands. Follow `next_cursor` before reporting that nothing amended a provision.

**Check `version.applied` on every dated read.** A date before the earliest revised version is answered with that later version: revised primary legislation starts at 1 February 1991 (Northern Ireland 1 January 2006), so European Communities Act 1972 s. 2 read at 1985-01-01 comes back as its 1991-02-01 text, with a notice that legislation.gov.uk holds no revised text before 1991-02-01. For an earlier date only version `enacted` exists; say so rather than quoting the base-date text as the law on that date.

**Original-only text is not evidence of current law.** When a current read returns `document_status` `final` and `version.available` holds only the enacted or made keyword, legislation.gov.uk has never revised the item. Original text cannot show a later repeal, and effects are normally recorded only from amending legislation of 1994 on, so zero effects proves nothing: the Rent Act 1965 returns its original text as a PDF link with no effects. Report what is held and that its current status is not shown.

**Three different dates answer "when".** An effect's `in_force` dates are when the law changed. A version date is when the provision's text changed. An effect's `modified` and a Publication Log event's `updated` are when legislation.gov.uk edited its records: republishing an item logs versions of it dated years earlier, so a Publication Log window measures editorial activity, not legal change. `uklaw_get_amendments` has no date filter and sorts by `modified`; a `counterpart` such as `uksi/2025` filters by the amending item's year, not when its effect applied.

**A quoted phrase must match the statutory wording.** `"deposit return scheme"` misses the Deposit and Return Scheme for Scotland Regulations 2020, which `"deposit and return scheme"` finds. Quote the drafting term, or drop the quotes.

## Workflows

**Is a provision in force and current?** Resolve it with `uklaw_lookup_citation` (`provision_found` confirms it exists now), then read it with `uklaw_get_document`. Apply the in-force gate to `provision.status` and the `I` annotations, the lag gate to `unapplied_effects`, and the container gate before answering.

**Commencement of an Act.** Commencements are effects of type "coming into force" whose `in_force` qualification reads "wholly in force", "for specified purposes", or "in force in so far as not already in force", sometimes prefixed by a territory ("for S.", "for W. for specified purposes") that limits where it was commenced; "for specified purposes" leaves the rest uncommenced. List them on the Act with `uklaw_get_amendments` (a commencement order as `counterpart` narrows to one order), or with direction `affecting` on the order to see everything it commenced.

**Text on a date, or a comparison.** Read with the date as `version` and check `version.applied`. `provision.valid_from` and `valid_to` give the provision's own text window, which can differ from the document version's. To compare two dates, read the provision at each; the `F` annotations on the later read cite each amending provision, usually with its effective date in parentheses.

**What amended a provision.** The current read's annotations are its applied history in one call: `F` for textual amendments, `C` for modifications that leave the words unchanged; follow a citation URI straight into `uklaw_get_document`. Pending changes are in `unapplied_effects`. Every recorded effect, commencements and repeals included, comes from `uklaw_get_amendments` with the provision, under the completeness gate. What an item does to other legislation is direction `affecting`.

**What changed since a date.** For one provision, `valid_from` on the current read is when its present text took effect; if that is after the date, read it at the date and compare, and date each change from the current read's `F` annotations or from the `in_force` dates of its `uklaw_get_amendments` effects. For newly published legislation, read `uklaw_track_changes` with content type legislation and first-time items only, then read each new item.
