# 🆕 Update v2 — Weather, Voting, and Photos

This update adds three new features:

1. **Weather on dashboard** — upcoming weekend forecast card with playability verdict
2. **Availability voting** — ✅ In / ❓ Maybe / ❌ Out buttons for each player
3. **Weekly photo uploads** — one photo per weekend, auto-compressed, shared with everyone

---

## ⚠️ One-time Firebase setup needed

Photo uploads use **Firebase Storage**, which is different from the Firestore Database you already set up. You need to enable Storage once.

### Step 1 — Enable Firebase Storage

1. Go to **https://console.firebase.google.com** and open your `tennis-tracker` project
2. In the left sidebar: **Build** → **Storage**
3. Click **"Get started"**
4. When asked about security rules, choose **"Start in production mode"** (we'll override them next)
5. Pick the same region you used for Firestore — click **Done**
6. Wait ~30 seconds for Storage to provision

### Step 2 — Set Storage security rules

1. Still in the Storage section, click the **"Rules"** tab at the top
2. Replace everything with this:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /photos/{photoId} {
      allow read: if true;
      allow write: if request.resource.size < 3 * 1024 * 1024
                   && request.resource.contentType.matches('image/.*');
    }
  }
}
```

3. Click **Publish**

These rules let anyone with your URL:
- **Read** photos (so they display in the app)
- **Upload** images up to 3MB (blocks huge files and non-images)
- Only under the `photos/` folder (nothing else can be written)

### Step 3 — Upload the new code to GitHub

Three files changed:
- `index.html` (new Photos tab, weekend coordinator slot)
- `styles.css` (styles for voting buttons, photos)
- `app.js` (all the new logic)

On GitHub, replace these three files with the ones from this update. Vercel redeploys automatically.

---

## Free tier limits (you're well within these)

| Resource | Free tier | Your usage |
|----------|-----------|------------|
| Storage space | 5 GB total | ~200KB per photo × 52 weeks/year × 5 years = ~52 MB |
| Downloads/day | 1 GB | Way under |
| Uploads/day | 20,000 | 5 friends, 1 photo/week = nothing |

At 1 photo per week, you won't touch the paid tier for **decades**.

---

## What you'll see in the updated app

### Dashboard (new weekend coordinator card)

At the top of the dashboard, a card shows:
- Next Saturday and Sunday toggle
- Weather summary (temp, rain %, wind, playability badge)
- Voting row for each player (In / Maybe / Out)
- Tally: "2 in, 2 maybe, 1 out — need 1 more"

### Photos tab (new)

- Upload picker — pick uploader, pick image, see preview with compressed size
- Timeline — all photos newest first, tap to view full size
- Delete button per photo (removes from Storage to free space)

### No changes to existing features

Matches, leaderboard, ELO, rotation, chemistry, CSV export — all work exactly as before. Your existing data carries over.

---

## Troubleshooting

**"Upload failed" error**
→ You forgot Step 2 (Storage Rules). Publish them and try again.

**Photo doesn't show up after upload**
→ Refresh the page. The Firebase sync is usually instant but can occasionally take a few seconds.

**Votes don't save**
→ Should work automatically since Firestore rules already allow `tennis/shared` writes. If it doesn't, check the browser console (F12) for errors.
