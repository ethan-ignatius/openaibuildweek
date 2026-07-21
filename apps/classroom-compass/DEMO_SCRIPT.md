# Classroom Compass — headless tutor + Excalidraw demo

## One-command demonstration

```bash
npm install
npm run tutor:demo
```

No browser or frontend is involved.

That command verifies the background loop only. For the projected visual demonstration, use two terminals:

```bash
# Terminal 1
npm run board:dev

# Terminal 2
npm run tutor -- demo --board
```

Open the `/board` URL printed in Terminal 1 and make it full screen. This is a projector canvas, not a teacher dashboard.

## Presenter narrative

1. Explain that camera and microphone processing run as local device adapters. They send structured observations—not stored media—to the headless tutor.
2. Run `npm run tutor:demo`.
3. Point out the fictional question about `0.35` and `0.4` is handled by a reviewed decimal policy, not an unrestricted chatbot.
4. Excalidraw receives a public-only scene: `0.4 = 0.40`, a place-value chart, exact hundred grids, and a number line. No student reference or private interpretation is present.
5. The tutor speaks the alternative representation while the fixture answers incorrectly once. The canvas and speaker provide one hint.
6. The second response is correct. The canvas says to check independently later instead of claiming mastery.
7. Highlight the final output: one observed evidence record and zero bytes of raw media retained.

## Live-service control demonstration

Start the service:

```bash
npm run dev
```

From a second terminal:

```bash
npm run tutor -- health
npm run tutor -- pause
npm run tutor -- resume
npm run tutor -- export
npm run tutor -- stop
```

The health output reports runtime state, sensor adapter state, any active short interaction, and `rawMediaRetainedBytes: 0`.

## Real microphone trial on macOS

Start `npm run board:dev`, then in a second terminal run:

```bash
npm run voice:build
npm run voice:run
```

Allow the macOS Microphone and Speech Recognition permissions. Ask any educational question, remain quiet for about two seconds, and watch the thinking scene followed by the model-generated Excalidraw explanation. Good examples include “Why is the sky blue?”, “How does photosynthesis work?”, and “What is the difference between area and perimeter?” Keep speaker output disabled unless using headphones so the transcriber does not hear the tutor itself.

The live path is not a hard-coded question matcher: open-ended questions use the local Ollama model. Recognized decimal comparisons use a general reviewed computation tool over the spoken values, keeping the showcase arithmetic reliable without storing fixed question-and-answer pairs.
