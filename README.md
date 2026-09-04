# JumpLab — Vertical Jump Analyzer

Professional, mobile-first vertical jump measurement for GitHub Pages. Uses the **flight-time method**:

\[
h = \frac{g \cdot t^{2}}{8}
\]

where \(t\) is time in the air and \(g = 9.80665\,\mathrm{m/s^{2}}\).

## Modes

### 1. Live Camera
- Point the phone so the athlete’s **feet** are in the green zone at the bottom of the frame
- Tap **Arm Sensor**, stand still briefly, then jump
- Motion in the feet ROI detects takeoff and landing
- Flight time → jump height automatically
- Audio cues + session history

### 2. Video Upload (highest accuracy)
- Upload any jump video (side view recommended)
- Scrub frame-by-frame
- **Set Takeoff** = last frame both feet are on the ground
- **Set Landing** = first frame a foot contacts the ground again
- Enter real FPS if known (30 / 60 / 120 / 240)
- Save the result to history

## Features
- cm / inches toggle
- Best & average in session
- Local history (no account)
- PWA-ready dark UI
- Pure client-side — no backend

## Deploy to GitHub Pages
1. Create a repo and upload these files to the root (or `/docs`)
2. Settings → Pages → deploy from that branch/folder
3. Open the HTTPS URL on your phone

Camera access requires HTTPS (GitHub Pages) or localhost.

## Accuracy notes
- **Video mode** is more precise when FPS is correct and marks are frame-accurate
- **Live mode** depends on lighting, camera angle, and sensitivity setting
- Flight-time method assumes vertical takeoff/landing and neglects arm contribution to hang time in some styles
- For lab-grade results use force plates; JumpLab is a practical field tool

## License
MIT
