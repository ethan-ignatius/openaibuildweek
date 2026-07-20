import type { BoardElement, BoardRegion } from "@teacher-brain/shared";
import { BoardElementView } from "./BoardElementView";
import { regionForElement } from "./board-state";
import { useBoardSocket } from "./use-board-socket";

const REGIONS: BoardRegion[] = [
  "top",
  "left",
  "center",
  "right",
  "scratch",
  "bottom",
];

const REGION_LABELS: Record<BoardRegion, string> = {
  top: "Lesson",
  left: "Recall",
  center: "Work",
  right: "Check",
  scratch: "Scratch space",
  bottom: "Next step",
};

function groupByRegion(elements: BoardElement[]) {
  const grouped = Object.fromEntries(
    REGIONS.map((region) => [region, [] as BoardElement[]]),
  ) as Record<BoardRegion, BoardElement[]>;

  for (const element of elements) {
    grouped[regionForElement(element)].push(element);
  }
  return grouped;
}

export function App() {
  const { state, connection } = useBoardSocket();
  const grouped = groupByRegion(Object.values(state));

  return (
    <main className="smartboard">
      <header className="board-header">
        <div>
          <span className="brand-mark">TB</span>
          <div>
            <strong>Teacher Brain</strong>
            <span>Live board</span>
          </div>
        </div>
        <span className={`connection-status connection-${connection}`}>
          <i aria-hidden="true" />
          {connection}
        </span>
      </header>

      <div className="board-layout">
        {REGIONS.map((region) => (
          <section className={`board-region region-${region}`} key={region}>
            <span className="region-label">{REGION_LABELS[region]}</span>
            <div className="region-content">
              {grouped[region].map((element) => {
                const key =
                  element.action.type === "board.show_slide"
                    ? "active-slide"
                    : element.action.element_id;
                return <BoardElementView element={element} key={key} />;
              })}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
