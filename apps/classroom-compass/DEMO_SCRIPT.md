# Classroom Compass — headless tutor + Visual Stage demo

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
4. The Visual Stage receives a public-only scene: `0.4 = 0.40`, a place-value chart, exact hundred grids, and a number line. Shapes and connections enter once to guide attention. No student reference or private interpretation is present.
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

Allow the macOS Microphone and Speech Recognition permissions. Ask any educational question, remain quiet for about two seconds, and watch the current teaching visual remain in place until the generated Visual Stage explanation is ready. Good examples include “Why is the sky blue?”, “How does photosynthesis work?”, and “What is the difference between area and perimeter?” Keep speaker output disabled unless using headphones so the transcriber does not hear the tutor itself.

The default board prioritizes presentation speed and clarity. Open `/board/excalidraw` instead when you want to add freehand marks with a pen, touch, or mouse.

The live path is not a hard-coded question matcher: open-ended questions use the local Ollama model. Recognized decimal comparisons use a general reviewed computation tool over the spoken values, keeping the showcase arithmetic reliable without storing fixed question-and-answer pairs.

## Photosynthesis bilingual interruption demo

The local `.env` demo preset starts an English grades 4–8 photosynthesis lesson automatically. The reviewed lesson context requires the explanation to connect water from roots, carbon dioxide through stomata, light captured by chlorophyll, glucose production, and oxygen release. It also supplies the word equation and balanced chemical equation so the model does not need to reconstruct core facts from the spoken prompt.

1. Start `npm run room:preview` and open `http://localhost:3000/board`.
2. Let the opening explanation establish the leaf-centered process. The current visual stays on screen while the next model turn is prepared.
3. From camera-left, have Ethan raise an open palm and ask an English question such as: “If plants make glucose, why do they still need water?” Confirm that the answer and public diagram remain in English.
4. After the lesson resumes, have Emanuel raise an open palm from camera-right and ask: “¿Cómo entra el dióxido de carbono en la hoja?” Confirm that Sarah answers primarily in Spanish, the diagram labels are Spanish, and a brief English recap follows.
5. Confirm that the system reconnects in English to the exact photosynthesis step that was paused rather than restarting the lesson.

The configured OpenAI reasoning effort is `low`. A student interruption currently performs a learner-memory model call followed by the teaching-plan model call, so the observed wait can be longer than reasoning effort alone suggests.
