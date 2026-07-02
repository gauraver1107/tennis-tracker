# 🎾 Weekend Tennis Tracker

A shared doubles-tennis tracker for 5 friends. Real-time sync across phones, ELO ratings, rotation suggestions, and one-tap WhatsApp sharing.

---

## 📋 What you need (all free)

1. A **Google account** (for Firebase)
2. A **GitHub account** (for hosting the code) — we'll create one
3. A **Vercel account** (for the live website) — we'll create one

**Total time:** about 45 minutes. **Total cost:** $0.

---

## Step 1 — Set up Firebase (the database)

Firebase is Google's free service that will store your match data. The free tier easily handles 5 people.

### 1a. Create a Firebase project

1. Go to **https://console.firebase.google.com**
2. Sign in with your Google account
3. Click **"Add project"** (or "Create a project")
4. Name it something like `tennis-tracker` — click Continue
5. When asked about Google Analytics, toggle it **OFF** (you don't need it) and click Create
6. Wait ~30 seconds for the project to be created, then click **Continue**

### 1b. Create the database

1. In the left sidebar, click **"Build"** → **"Firestore Database"**
2. Click **"Create database"**
3. Choose **"Start in test mode"** (this lets your friends read/write for 30 days — we'll extend it later)
4. Pick a location near you (for US: `us-east1` or `us-central1`). Click **Enable**

### 1c. Register your web app

1. In the left sidebar, click the ⚙️ gear icon → **"Project settings"**
2. Scroll down to **"Your apps"** section
3. Click the **`</>`** (web) icon
4. Give it a nickname like `tennis-web` → click **Register app**
5. You'll see a code snippet with a `firebaseConfig` object that looks like this:

   ```javascript
   const firebaseConfig = {
     apiKey: "AIzaSyB...",
     authDomain: "tennis-tracker-abc.firebaseapp.com",
     projectId: "tennis-tracker-abc",
     storageBucket: "tennis-tracker-abc.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abc123"
   };
   ```

6. **Copy these values** — you'll paste them into `firebase-config.js` in Step 2. Keep this browser tab open.

### 1d. Extend the database rules (so it works beyond 30 days)

1. Back in the sidebar: **Firestore Database** → click the **"Rules"** tab at the top
2. Replace everything with this:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /tennis/{docId} {
         allow read, write: if true;
       }
     }
   }
   ```

3. Click **Publish**

> **Security note:** These rules let anyone who knows your URL read/write your match data. Since only your 5 friends will have the URL, this is fine for a private tracker. If you ever want to lock it down, I can show you how to add a password later.

---

## Step 2 — Put your Firebase keys into the code

1. Download the project folder and unzip it
2. Open `firebase-config.js` in any text editor (Notepad, VS Code, TextEdit — anything)
3. Replace each `"REPLACE_WITH_YOUR_..."` with the actual value you copied from Firebase
4. Save the file

Example of what the finished file should look like:

```javascript
export const firebaseConfig = {
  apiKey: "AIzaSyB...",
  authDomain: "tennis-tracker-abc.firebaseapp.com",
  projectId: "tennis-tracker-abc",
  storageBucket: "tennis-tracker-abc.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc123"
};
```

---

## Step 3 — Create a GitHub account and upload the code

GitHub is where the code lives. Vercel (next step) will grab the code from here.

### 3a. Sign up for GitHub

1. Go to **https://github.com/signup**
2. Enter your email, create a password, pick a username (this will appear in your app's URL, so choose something clean like your name)
3. Verify your email via the code they send

### 3b. Create a new repository

1. Once signed in, click the **"+"** icon (top right) → **"New repository"**
2. Repository name: `tennis-tracker`
3. Set it to **Public** (Vercel's free tier requires this — don't worry, your Firebase keys are safe because they're meant to be public)
4. **Don't** check any of the "Add README / .gitignore / license" boxes
5. Click **"Create repository"**

### 3c. Upload your files (the easy way — no terminal needed)

1. On the empty repository page, click **"uploading an existing file"** (it's a link in the middle of the page)
2. Open the `tennis-tracker` folder on your computer in a file browser
3. Select ALL the files (index.html, styles.css, app.js, firebase-config.js, README.md) and drag them into the GitHub upload area
4. Wait for them to upload (you'll see green checkmarks)
5. Scroll down and click **"Commit changes"**

You should now see all your files listed in the repository. 🎉

> **Tip:** To update the code later, click any file → click the pencil ✏️ icon → edit → scroll down → Commit changes. Or drag new files the same way.

---

## Step 4 — Deploy to Vercel (publish the website)

### 4a. Sign up for Vercel

1. Go to **https://vercel.com/signup**
2. Click **"Continue with GitHub"** — it'll ask to connect to your GitHub account, click Authorize
3. Choose the **Hobby (free)** plan when prompted

### 4b. Import your repository

1. On your Vercel dashboard, click **"Add New..."** → **"Project"**
2. You'll see your `tennis-tracker` repo — click **"Import"**
3. Leave all the default settings as they are
4. Click **"Deploy"**
5. Wait ~30 seconds — you'll see confetti when it's done! 🎉
6. Click **"Continue to Dashboard"** and you'll see your live URL (something like `tennis-tracker-abc123.vercel.app`)

### 4c. Test it

1. Click the URL — your app should load
2. Go to the **Players** tab, update the 5 names
3. Log a test match
4. Open the same URL on your phone — the match should appear instantly (that's the Firebase sync working)

---

## Step 5 — Share with your friends

1. Copy your Vercel URL
2. In your WhatsApp group: tap the group name → scroll to **"Group description"** → paste the URL there
3. Also send a message like: "🎾 Use this to log our matches and see the leaderboard: [URL]"
4. Tell friends to tap the link on their phone, then tap the **Share** menu → **"Add to Home Screen"** — it behaves like an app

---

## 🔄 How to update the app later

Once you have feedback from friends and want to add features:

1. Edit the file (either on your computer or directly on GitHub with the ✏️ icon)
2. Commit the change on GitHub
3. Vercel **automatically redeploys** within ~30 seconds
4. Your friends refresh the page and see the new version

This is why this setup is perfect for iterating based on feedback.

---

## 🆘 Troubleshooting

**"The app loads but nothing saves"**
→ Double-check your `firebase-config.js` values. All six fields must match what Firebase shows in Project Settings.

**"Permission denied" error in browser console (F12)**
→ You forgot Step 1d (the Firestore Rules). Go back to Firebase → Firestore → Rules and publish the rules shown above.

**"App looks broken on mobile"**
→ Try a hard refresh: on iOS Safari, close the tab and reopen. On Android Chrome, Settings → tap the refresh icon.

**"I want to change who can write to the app"**
→ Ask Claude to help you add a simple password. It's about 10 lines of code.

---

## 📂 Project files

| File | What it does |
|------|--------------|
| `index.html` | The app's structure |
| `styles.css` | The visual design |
| `app.js` | All the logic — matches, ELO, sync |
| `firebase-config.js` | Your Firebase credentials (edit this once) |
| `README.md` | This file |

---

## 💡 Ideas for future features

- Weather tracking per match (call a free weather API)
- Photo upload for memorable moments
- Voice entry ("Siri, tell the tennis app Alice and Bob won")
- Yearly awards (most matches played, biggest upset, longest win streak)
- Separate singles tracking
- Add a 6th/7th player

When you're ready for any of these, just ask Claude!

---

Built with ❤️ and 🎾
