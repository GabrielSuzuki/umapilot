# Applying patches

How to get a patch I hand you in chat into the repo. Written for **PowerShell on
Windows**, which is what you're running — the commands differ from the bash ones
you'll find in most git docs, and two of those differences have already cost us
time (see [Gotchas](#gotchas)).

The whole flow is: put the files in the repo, apply them in order, regenerate the
dataset, test, push.

## 1. Move the patches into the repo folder

Download them from the chat, then:

```powershell
cd C:\path\to\umapilot
Move-Item "$HOME\Downloads\0001-*.patch" .
Move-Item "$HOME\Downloads\0002-*.patch" .
```

`Move-Item` expands wildcards fine — it's `git am` that doesn't. Substitute the
real filenames if your Downloads folder is somewhere else.

## 2. Check the tree is clean

```powershell
git status --short
```

If anything prints, commit or stash it first. `git am` refuses to run on a dirty
tree, and the error it gives ("working tree is dirty. Commit or stash first.")
doesn't tell you which file.

## 3. Apply them, in order

```powershell
git am 0001-Track-group-cards-a-third-card-kind-not-a-friend-car.patch
git am 0002-Team-Sirius-is-banned-from-Grand-Concert-not-exclusi.patch
```

**These are sequential, not alternatives.** Run every patch, one after another,
in numeric order — a later patch usually edits code an earlier one introduced.

If you'd rather not type the long names, this pipes them in sorted order:

```powershell
Get-ChildItem *.patch | Sort-Object Name | ForEach-Object FullName | git am
```

> **Only ever have one series in the folder at a time.** Patch numbering restarts
> at `0001` for every batch I generate, so two batches sitting side by side give
> you two files called `0001-…`, two called `0002-…`, and so on. Sorted by name
> they interleave, and `git am` will try to apply them in an order that cannot
> work. Before downloading a new batch, run `Remove-Item *.patch` — or apply each
> file by its full name, where the collision is harmless.

## 4. Verify

```powershell
git log --oneline -5
```

The newest patch should be on top, and the commit below it should be what your
`HEAD` was before you started.

## 5. Regenerate the dataset

Any patch that touches `tools/extract/` changes what the extractor emits, and the
generated JSON is **not** committed — it's derived from your own `master.mdb`, so
it's in `.gitignore`. Your local copy is stale until you re-run it:

```powershell
npm run extract
```

Skipping this is a confusing failure mode: the tests read the generated files, so
you get failures that look like the patch is broken when the data is simply old.

## 6. Test, then push

```powershell
npm test
git push
```

## 7. Clean up

```powershell
Remove-Item *.patch
```

Patch files aren't in `.gitignore`, so leaving them around means they'll get
swept into some later `git add -A`.

## If something goes wrong

```powershell
git am --abort
```

That puts you back exactly where you started with nothing applied. It's the safe
reset — use it rather than trying to repair a half-applied patch, then send me
what it printed.

Two failures worth naming:

- **"patch does not apply"** — your `HEAD` isn't where the patch expects. Usually
  it means an earlier patch in the series was skipped, applied twice, or two
  numbered series got mixed in the folder. `git log --oneline -5` shows where you
  actually are; compare it against what I said the series starts from.
- **"previous rebase directory .git/rebase-apply still exists"** — a previous
  `git am` stopped partway and was never resolved. `git am --abort` clears it.

## Gotchas

These are specific to PowerShell and have all bitten us at least once.

- **`git am 0001-*.patch` does not work.** PowerShell doesn't expand wildcards
  for external programs — git receives the literal string `0001-*.patch` and
  reports `fatal: could not open '0001-*.patch' for reading`. Pass the full
  filename, or use the `Get-ChildItem` pipeline above.
- **`&&` and `||` aren't chaining operators in Windows PowerShell 5.1.** A
  command like `cmd1 || cmd2` is a parser error. Run the commands on separate
  lines. (PowerShell 7+ supports both, so this depends on which you're in —
  `$PSVersionTable.PSVersion` tells you.)
- **`grep` doesn't exist.** Use `Select-String`. For example, the "no game data
  is tracked" check from `PUSH.md` becomes:

  ```powershell
  git ls-files | Select-String -Pattern '\.mdb|generated/.*\.json'
  ```

  which must print nothing.
- **File modes.** `core.fileMode` is set to `false` in this repo's config
  because NTFS can't store the executable bit, and without it every shell script
  shows as modified forever. If you ever re-clone, that setting comes from the
  repo, so you shouldn't need to redo it — but if `git status` starts reporting
  mode-only changes on `.sh` files, `git config core.fileMode false` is the fix.

## Related

- `PUSH.md` — first-time GitHub setup and the pre-push safety check.
- `CONTRIBUTING.md` — the one rule: don't write a guess into the dataset.
