# GESTURE-SYNTH

Gesture Synth is a single-page interactive web app built using React, Tailwind CSS, MediaPipe Hands (via `@mediapipe/camera_utils` and `@mediapipe/hands`), and Tone.js. It allows users to use their webcam to control a web-based musical synthesizer using advanced hand gestures.

---

### Core Features & Architecture

1. **Webcam & Hand Tracking Feed:**
   - Initializes a responsive webcam feed with real-time hand landmark tracking powered locally in the browser via MediaPipe Hands.
   - Cleans up camera streams and animation frames (`requestAnimationFrame`) on component unmount to prevent memory leaks.

2. **Dual Mode Interface (Gesture & Theremin):**
   - **Gesture Mode:** 
     - **Left Hand:** The finger pose picks a chord in G major, visualized as a dynamic row of cards with roman numerals (I, ii, iii...). Tilting the hand switches between major and minor scales.
     - **Right Hand:** Its pose sets the playing style (pad, arpeggio, rhythmic pulse, or mute via fist), while its height controls the volume.
     - **Stability & Performance:** Implements debouncing (requiring a pose to hold for 3 consecutive frames) to eliminate flicker and stutter.
   - **Theremin Mode:** 
     - A classic pitch-and-volume control tab featuring pinch-to-play gestures (distance between thumb tip `[4]` and index tip `[8]`).

3. **Tone.js Synthesizer & Audio Setup:**
   - Powered by lightweight oscillators, atmospheric reverbs, and custom synths.
   - Includes a user-friendly start/resume audio context trigger to handle browser autoplay policies.

4. **Performance & Lag Optimizations:**
   - Uses optimized lightweight hand-tracking models.
   - Stripped heavy blur and glow effects on canvas drawing to maintain high frame rates on mobile and lower-end devices.
   - Throttles on-screen state readouts to ~10 updates per second instead of rendering every frame.

---

### Tech Stack
* **Framework:** React + Vite
* **Styling:** Tailwind CSS, Custom Glassmorphism CSS
* **Computer Vision:** Google MediaPipe Hands
* **Audio Engine:** Tone.js

### Testing & Verification Checklist
1. Show 1, 3, then 5 fingers on the left hand to verify the chord cards highlight G, B, and D.
2. Tilt the left hand to toggle the key between major and minor.
3. Switch the right hand between 1, 2, and 3 fingers to cycle between pad, arpeggio, and pulse synth modes.
4. Make a fist with the right hand to mute audio output.
5. Switch to the Theremin tab and test pinch-to-play functionality.
