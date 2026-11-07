# 🔗 Custom Sources

Add your own scripts and snippets to Nexterm by connecting a Git repository. You can use public repositories from GitHub, GitLab, or any other Git hosting platform.

## Adding a Source

1. Open **Settings** and go to **Sources**

![Navigate to Sources](/assets/image-1.png)

2. Click **Add** and enter a name and the repository URL

![Create Custom Source](/assets/image-3.png)

The name is just for display purposes, so choose something descriptive.

## Using Your Scripts & Snippets

Once added, your scripts and snippets are available in the Snippets panel. Select your repository from the dropdown to see its contents.

![Add Snippet Dropdown](/assets/image-4.png)

Switch to the **Scripts** tab to access your scripts.

![Scripts Tab View](/assets/image-6.png)

## Syncing

Nexterm syncs all sources when it starts and then once an hour. To pull changes right away, click **Sync now** on the source.

You can add multiple sources if you want to organize scripts by project or team.

## The NTINDEX file

A source is a base URL that serves a plain text file called `NTINDEX` next to your files. Every line lists a file path (relative to the base URL) and the MD5 hash of that file, separated by `@`. Lines starting with `#` are comments.

```txt
# Scripts
scripts/10_largest_files.sh@416971fdb24f74464841958621d4940c

# Snippets
snippets/system-update.snippet@8dad141f6046c825e06b201239a742cc
```

The hash lets Nexterm detect which files changed. You can generate the file automatically with a GitHub Action:

::: details Example workflow: `.github/workflows/ntindex.yml`

```yaml
name: Generate NTINDEX
on:
  push:
    branches: [main]
    paths-ignore: [NTINDEX]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  ntindex:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Generate NTINDEX
        run: |
          find . -type f \( -name '*.snippet' -o -name '*.txt' -o -name '*.cmd' \
            -o -name '*.sh' -o -name '*.bash' -o -name '*.zsh' -o -name '*.fish' -o -name '*.ps1' \
            -o -name '*.theme.css' \) ! -iname 'readme*' -not -path './.git/*' -not -path './.github/*' \
            | sed 's|^\./||' | sort | while read -r file; do
              echo "${file}@$(md5sum "$file" | cut -d' ' -f1)"
            done > NTINDEX
      - name: Commit NTINDEX
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add NTINDEX
          git diff --staged --quiet || (git commit -m "chore: update NTINDEX" && git push)
```

It indexes every file with a supported extension in the repository, so keep other `.txt` files out of it.

:::

## Private GitHub repositories

A source can be read from a **private** repository by adding an access token. Nexterm sends it as an `Authorization: Bearer` header with every request to the source.

1. Create a [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens):
    - **Resource owner:** the account or organization that owns the repository. Organizations can require an approval for fine-grained tokens.
    - **Repository access:** *Only select repositories*, and choose just this repository.
    - **Permissions:** *Contents* set to *Read-only* (*Metadata* is added automatically).
2. Make sure the repository contains an [`NTINDEX`](#the-ntindex-file).
3. In **Settings** → **Sources**, click **Add**, enter the GitHub API URL of the folder that contains your `NTINDEX` and paste the token into **Access token**:

| Location of the `NTINDEX` | Source URL |
|---------------------------|------------|
| Repository root | `https://api.github.com/repos/OWNER/REPO/contents` |
| Folder `nexterm` | `https://api.github.com/repos/OWNER/REPO/contents/nexterm` |
| Another branch | Add `?ref=BRANCH`, e.g. `https://api.github.com/repos/OWNER/REPO/contents?ref=dev` |

> [!TIP]
> To check the token and URL before adding the source, this command should print your index:
> ```sh
> curl -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github.raw+json" \
>   "https://api.github.com/repos/OWNER/REPO/contents/NTINDEX"
> ```

> [!NOTE]
> - The token is stored encrypted with your `ENCRYPTION_KEY` and is never shown again. If you change the `ENCRYPTION_KEY`, enter the token again.
> - It is only sent to the host of the source URL. To move a source that has a token to another host, enter the token again or remove it.
> - Do not put the token into the URL. Nexterm rejects URLs that contain credentials.
> - While a token is set, entries in `NTINDEX` that point outside of the source URL (`../`) are skipped.
> - This is built for GitHub's contents API. Other hosts only work if they accept a Bearer token for file downloads, and hosts on private networks are blocked.

> [!TIP]
> See [Scripts & Snippets](/scripts&snippets) for how to format your files.
