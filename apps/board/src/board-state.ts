import type {
  BoardAction,
  BoardElement,
  BoardRegion,
  BoardServerEvent,
} from "@teacher-brain/shared";

export type BoardState = Record<string, BoardElement>;

export const M0_STARTER_ACTIONS: BoardAction[] = [
  {
    type: "board.write_text",
    region: "top",
    text: "Solving linear equations",
    element_id: "lesson-title",
  },
  {
    type: "board.write_math",
    region: "center",
    latex: String.raw`3x + 5 = 20`,
    element_id: "m0-equation",
  },
  {
    type: "board.highlight",
    element_id: "m0-equation",
    style: "pulse",
  },
];

function isRenderedAction(
  action: BoardAction,
): action is BoardElement["action"] {
  return ![
    "board.highlight",
    "board.unhighlight",
    "board.clear",
  ].includes(action.type);
}

export function elementIdForAction(action: BoardElement["action"]): string {
  return action.type === "board.show_slide"
    ? "__active_slide__"
    : action.element_id;
}

export function regionForElement(element: BoardElement): BoardRegion {
  return "region" in element.action ? element.action.region : "center";
}

export function applyBoardAction(
  state: BoardState,
  action: BoardAction,
): BoardState {
  if (action.type === "board.clear") {
    if (action.region === "all") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(state).filter(
        ([, element]) => regionForElement(element) !== action.region,
      ),
    );
  }

  if (
    action.type === "board.highlight" ||
    action.type === "board.unhighlight"
  ) {
    const existing = state[action.element_id];
    if (!existing) {
      return state;
    }

    const nextElement: BoardElement = { action: existing.action };
    if (action.type === "board.highlight") {
      nextElement.highlight = action.style;
    }

    return { ...state, [action.element_id]: nextElement };
  }

  if (!isRenderedAction(action)) {
    return state;
  }

  const elementId = elementIdForAction(action);
  return { ...state, [elementId]: { action } };
}

export function createStarterState(): BoardState {
  return M0_STARTER_ACTIONS.reduce(applyBoardAction, {});
}

export function boardReducer(
  state: BoardState,
  event: BoardServerEvent,
): BoardState {
  if (event.type === "board.snapshot") {
    return Object.fromEntries(
      event.elements.map((element) => [
        elementIdForAction(element.action),
        element,
      ]),
    );
  }

  if (event.type === "board.action") {
    return applyBoardAction(state, event.action);
  }

  return state;
}
