# Bookmark Cleaner

A Chrome extension for managing and cleaning up your bookmarks with a proper UI — including a dead link scanner that finds and removes broken bookmarks.

## Features

- **Browse & manage bookmarks** — navigate folders, rename, delete, and edit bookmarks
- **Dead Link Scanner** — scans all bookmarks for broken links (HTTP errors, timeouts, network failures) and presents only the broken ones for review
  - Open, edit, or delete broken bookmarks individually
  - Bulk delete all broken bookmarks at once
  - Cancel a scan in progress

## Installation

This extension is not published to the Chrome Web Store. Install it manually in developer mode:

1. **Download or clone this repository**
   ```bash
   git clone https://github.com/John-JCIT/bookmark-cleaner-extension.git
   ```

2. **Open Chrome and go to** `chrome://extensions`

3. **Enable Developer Mode** using the toggle in the top-right corner

4. **Click "Load unpacked"** and select the folder containing the extension files (the root of this repo — the folder with `manifest.json` in it)

5. **Pin the extension** (optional) — click the puzzle piece icon in Chrome's toolbar and pin Bookmark Cleaner for easy access

6. **Click the extension icon** to open the bookmark manager in a new tab

## Usage

### Browsing Bookmarks
- Click any folder to open it and see its bookmarks
- Use the back arrow to navigate up
- Click the pencil icon on a bookmark to rename or change its URL
- Click the trash icon to delete a bookmark

### Dead Link Scanner
1. Click the **Dead Links** tab at the top of the extension
2. Click **Start Scan** — the extension will check every bookmark URL in your library
3. Broken links are listed with a status badge:
   - **Red** — HTTP error (e.g. 404 Not Found)
   - **Orange** — Timeout (site took too long to respond)
   - **Blue** — Network error (could not connect)
4. For each broken bookmark you can:
   - **Open** — open the URL in a new tab to verify
   - **Edit** — update the URL or title
   - **Delete** — remove the bookmark
5. Use **Select All** and **Delete Selected** to bulk remove broken bookmarks
6. Click **Cancel** to stop a scan in progress

## Notes

- The scanner sends HTTP HEAD requests (falling back to GET if needed) to check links — no page content is downloaded
- Scans run at 5 concurrent requests to avoid overwhelming your connection
- Each request times out after 8 seconds
- Some sites may block automated requests and show as broken even if they work in a browser

## Development

To make changes:

1. Edit the source files (`app.js`, `background.js`, `style.css`, `index.html`)
2. Go to `chrome://extensions` and click the refresh icon on the Bookmark Cleaner card
3. **Close and reopen the extension tab** (click the icon again) — existing tabs won't reconnect after an extension reload
