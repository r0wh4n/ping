# Google Play listing: Ping

Everything here matches what the app does and what https://theping.chat/privacy says.
Update both together.

## Store listing

**App name** (30 max): `Ping: Private Chat`

**Short description** (80 max):
`Chat with a @handle you own. No phone number, no feed. Encrypted texts.`

**Full description** (4,000 max):

```
Ping is private chat built around a @handle you own. No phone number, no email, no real name: pick a handle and a password, and add people by theirs.

WHAT YOU GET
• A @handle instead of a phone number. Nothing ties your account to your real-world identity.
• End-to-end encrypted texts. Messages in your chats and groups are encrypted on your phone before they're sent, so Ping's servers can't read them.
• Disappearing messages. Set a timer per chat; it starts only once the message has been read.
• View-once snaps. Send a photo or video that opens once.
• Voice notes and photos. Location and camera details are removed from photos before they're uploaded.
• Voice and video calls between two people, encrypted by WebRTC.
• Live mode: a conversation that exists only while you're both in it. Nothing is written to any server.
• Groups and polls, with replies, reactions and pins.
• No feed, no algorithm, no ads.

GOOD TO KNOW
• Photos, videos and voice notes are stored privately but aren't end-to-end encrypted yet.
• There's no password reset. Ping has no way to reach you, so keep your password safe.
• Ping is for people aged 18 and over.
• You can delete your account in the app at any time, and your messages and files go with it.

Ping is open source: github.com/r0wh4n/ping
Privacy policy: theping.chat/privacy
```

**Category:** Communication
**Contact email:** privacy@theping.chat (or add a support@theping.chat forward in Cloudflare)
**Website:** https://theping.chat
**Privacy policy:** https://theping.chat/privacy

**Graphics** (in this folder):
- `icon-512.png`: 512×512, 32-bit PNG. Google rounds the corners.
- `feature-graphic.png`: 1024×500, 24-bit PNG with no transparency.
- Phone screenshots, 2 to 8 at 9:16: to capture from the Android app once the demo accounts exist.

## App content (Policy → App content)

| Form | Answer |
|---|---|
| Privacy policy | https://theping.chat/privacy |
| Ads | No ads |
| App access | All features need sign-in. Reviewer login: handle `pingreview`, password from your password manager (you enter it). Note: "To see a chat, open the conversation with @pingdemo." |
| Target audience | 18 and over; not designed for children |
| Content rating (IARC) | No violence, sexual content, drugs, gambling or profanity from the developer. **Users can interact and exchange content: Yes.** Shares location: No. Digital purchases: No. |
| News app | No |
| Government app | No |
| Financial features | None |
| Health | No |
| Account deletion | In the app: home screen → bottom → Delete account. On the web: https://theping.chat/privacy#rights (the steps, plus privacy@theping.chat) |

## Data safety (draft: confirm each answer before submitting)

- **Collects or shares required data types:** Yes
- **All data encrypted in transit:** Yes (HTTPS everywhere)
- **Users can request deletion:** Yes (in the app, and by email)
- **Shared with third parties:** No. Supabase, Vercel and Cloudflare process data on Ping's behalf, which Google does not count as sharing.

| Data type (Google's names) | Collected | Required? | Purpose |
|---|---|---|---|
| Personal info → User IDs (your @handle) | Yes | Required | App functionality, account management |
| Messages → Other in-app messages | Yes | Required | App functionality |
| Photos and videos → Photos, Videos | Yes | Optional | App functionality |
| Audio → Voice or sound recordings (voice notes) | Yes | Optional | App functionality |
| Device or other IDs (sign-up IP address; the Firebase notification token if you turn alerts on) | Yes | Required | Fraud prevention and security; app functionality |
| Location, contacts, financial info, health, web history, analytics | No | | |

Texts are end-to-end encrypted. "Other in-app messages" is still declared because photos, videos, voice notes, Ping HQ and agent rooms are readable by the server.

Notifications go through Google's Firebase Cloud Messaging (project `ping-5d0fa`), with Google Analytics off. No AI provider gets any data: `LLM_API_KEY` is not set, so agent-room summaries are written by each member's own AI tool.

## Before production: closed testing (new personal accounts)

1. Testing → Closed testing → create a track, upload `app-release.aab`, add at least 12 testers (an email list or a Google Group).
2. Each tester opts in through the link and stays opted in for 14 days in a row.
3. Then Dashboard → Apply for production access.

The bundle is `android/app/build/outputs/bundle/release/app-release.aab`, signed with the upload key in `~/.ping-keys/` (see `android/app/build.gradle`).
