<#
.SYNOPSIS
    Apply a series of git-format-patch files safely, on Windows PowerShell.

.DESCRIPTION
    Every failure this guards against has actually happened on this project:

      * Two or three patch series in one folder. Numbering restarts at 0001 for
        each batch, so sorting by name interleaves them and `git am` applies
        patches in an order that cannot work.
      * A stale patch whose commit is already in history, which fails with a wall
        of "already exists in index" that reads like a broken patch.
      * An empty file list. `git am` with no arguments silently reads stdin, so
        it looks like a freeze rather than an error.
      * A leftover .git/rebase-apply from a previous failed run.

    Nothing is applied until every check passes.

.EXAMPLE
    .\scripts\apply-patches.ps1

.EXAMPLE
    .\scripts\apply-patches.ps1 -Path $HOME\Downloads -Test
#>

[CmdletBinding()]
param(
    # Where the .patch files are. Defaults to the repo root.
    [string] $Path = ".",

    # Run `npm run extract` and `npm test` after applying.
    [switch] $Test,

    # Report what would happen and stop.
    [switch] $DryRun
)

$ErrorActionPreference = "Stop"

function Fail($message, $fix) {
    Write-Host ""
    Write-Host "REFUSED: $message" -ForegroundColor Red
    if ($fix) {
        Write-Host ""
        Write-Host $fix
    }
    Write-Host ""
    exit 1
}

# --- the repo must be ready ------------------------------------------------

git rev-parse --git-dir *> $null
if ($LASTEXITCODE -ne 0) { Fail "not inside a git repository." $null }

$gitDir = (git rev-parse --git-dir).Trim()
if (Test-Path (Join-Path $gitDir "rebase-apply")) {
    Fail "a previous 'git am' stopped partway and was never resolved." @"
Clear it, then run this again:

    git am --abort
"@
}

$dirty = git status --porcelain
if ($dirty) {
    Fail "the working tree has uncommitted changes; 'git am' will not run." @"
Commit or stash them first:

    git stash

Changed files:
$($dirty -join "`n")
"@
}

# --- collect the patches ---------------------------------------------------

$files = @(Get-ChildItem -Path $Path -Filter *.patch | Sort-Object Name)

if ($files.Count -eq 0) {
    Fail "no .patch files found in '$((Resolve-Path $Path).Path)'." @"
Download them into that folder first. This is the case that looks like a hang:
'git am' with no file arguments falls back to reading a patch from the keyboard
and prints 'warning: reading patches from stdin/tty...'.
"@
}

# Pull the number prefix and the commit subject out of each file.
$patches = foreach ($f in $files) {
    $number = $null
    if ($f.Name -match '^(\d{4})-') { $number = $Matches[1] }

    # Subject may be folded across continuation lines (leading whitespace).
    $subject = ""
    $inSubject = $false
    foreach ($line in Get-Content -LiteralPath $f.FullName) {
        if ($line -eq "") { break }                     # end of headers
        if ($inSubject) {
            if ($line -match '^\s+\S') { $subject += " " + $line.Trim(); continue }
            $inSubject = $false
        }
        if ($line -match '^Subject:\s*(.*)$') {
            $subject = $Matches[1]
            $inSubject = $true
        }
    }
    # Strip the "[PATCH n/m] " marker.
    $subject = ($subject -replace '^\[PATCH[^\]]*\]\s*', '').Trim()

    [pscustomobject]@{
        Name    = $f.Name
        Full    = $f.FullName
        Number  = $number
        Subject = $subject
    }
}

# --- refuse a mixed series -------------------------------------------------

$dupes = $patches | Where-Object { $_.Number } |
         Group-Object Number | Where-Object { $_.Count -gt 1 }
if ($dupes) {
    $detail = foreach ($d in $dupes) {
        "  $($d.Name):`n" + (($d.Group | ForEach-Object { "      $($_.Name)" }) -join "`n")
    }
    Fail "more than one patch series is in this folder." @"
Numbering restarts at 0001 for every batch, so these collide:

$($detail -join "`n")

Sorted by name they interleave, and 'git am' will apply them in an order that
cannot work. Delete the files from the older batch, keep one contiguous series,
then run this again.
"@
}

$numbered = @($patches | Where-Object { $_.Number })
if ($numbered.Count -eq $patches.Count -and $numbered.Count -gt 1) {
    $ints = $numbered | ForEach-Object { [int]$_.Number } | Sort-Object
    $expected = $ints[0]..$ints[-1]
    $missing = Compare-Object $expected $ints |
               Where-Object { $_.SideIndicator -eq "<=" } |
               ForEach-Object InputObject
    if ($missing) {
        Fail "the series has gaps: missing $($missing -join ', ')." @"
A patch in the middle is absent, so later ones will not apply. Re-download the
whole series.
"@
    }
}

# --- refuse patches already in history -------------------------------------
#
# 'git am' rewrites commit hashes, so a patch cannot be matched to history by
# id. The subject line is what survives, and it is enough: a patch whose subject
# is already a commit here is one you have applied before.

$history = @(git log --format=%s)
$stale = $patches | Where-Object { $_.Subject -and ($history -contains $_.Subject) }
if ($stale) {
    $detail = ($stale | ForEach-Object { "  $($_.Name)`n      -> `"$($_.Subject)`"" }) -join "`n"
    Fail "$($stale.Count) patch(es) are already in this repo's history." @"
$detail

Applying them again produces 'already exists in index' errors that look like a
broken patch but are not. Delete those files and run this again.
"@
}

# --- go --------------------------------------------------------------------

Write-Host ""
Write-Host "Applying $($patches.Count) patch(es) onto $(git rev-parse --short HEAD) ($(git log -1 --format=%s))" -ForegroundColor Cyan
foreach ($p in $patches) { Write-Host "  $($p.Number)  $($p.Subject)" }
Write-Host ""

if ($DryRun) {
    Write-Host "-DryRun set; nothing applied." -ForegroundColor Yellow
    exit 0
}

$paths = $patches | ForEach-Object Full
git am $paths
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "'git am' stopped. It applies patches one at a time and does NOT roll back," -ForegroundColor Yellow
    Write-Host "so some may already be committed. 'git log --oneline' shows how far it got." -ForegroundColor Yellow
    Write-Host "To return to where you started:  git am --abort" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Applied. HEAD is now $(git rev-parse --short HEAD)" -ForegroundColor Green

if ($Test) {
    # The generated dataset is not committed -- it comes from your own
    # master.mdb -- so a patch that changes the extractor leaves it stale. Tests
    # then fail against old data and look like the patch is broken.
    Write-Host ""
    npm run extract
    if ($LASTEXITCODE -ne 0) { exit 1 }
    npm test
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

Write-Host ""
Write-Host "Next:  git push" -ForegroundColor Cyan
Write-Host "Then:  Remove-Item *.patch" -ForegroundColor Cyan
