import DOMPurify from "dompurify";
import katex from "katex";
import type { BoardElement } from "@teacher-brain/shared";

function MathContent({ latex }: { latex: string }) {
  const markup = katex.renderToString(latex, {
    displayMode: true,
    throwOnError: false,
    trust: false,
  });
  return <div className="math-content" dangerouslySetInnerHTML={{ __html: markup }} />;
}

function FractionBars({ fractions }: { fractions: string[] }) {
  return (
    <div className="fraction-bars">
      {fractions.map((fraction) => {
        const [numeratorText, denominatorText] = fraction.split("/");
        const numerator = Number(numeratorText);
        const denominator = Number(denominatorText);
        return (
          <div className="fraction-row" key={fraction}>
            <span>{fraction}</span>
            <div
              className="fraction-track"
              style={{ gridTemplateColumns: `repeat(${denominator}, 1fr)` }}
            >
              {Array.from({ length: denominator }, (_, index) => (
                <i
                  className={index < numerator ? "fraction-filled" : undefined}
                  key={index}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NumberLine({
  min,
  max,
  marks,
}: {
  min: number;
  max: number;
  marks: Array<{ value: number; label?: string }>;
}) {
  const span = max - min || 1;
  return (
    <div className="number-line" aria-label={`Number line from ${min} to ${max}`}>
      <div className="number-line-axis" />
      {marks.map((mark) => (
        <div
          className="number-line-mark"
          key={`${mark.value}-${mark.label ?? ""}`}
          style={{ left: `${((mark.value - min) / span) * 100}%` }}
        >
          <i />
          <span>{mark.label ?? mark.value}</span>
        </div>
      ))}
    </div>
  );
}

export function BoardElementView({ element }: { element: BoardElement }) {
  const { action } = element;
  const className = [
    "board-element",
    element.highlight ? `highlight-${element.highlight}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const elementId =
    action.type === "board.show_slide" ? "active-slide" : action.element_id;

  let content: React.ReactNode;
  switch (action.type) {
    case "board.write_text":
      content = <p className="text-content">{action.text}</p>;
      break;
    case "board.write_math":
      content = <MathContent latex={action.latex} />;
      break;
    case "board.plot_function":
      content = (
        <div className="plot-content">
          <MathContent latex={`f(x)=${action.expr}`} />
          <span>
            {action.domain[0]} ≤ x ≤ {action.domain[1]}
          </span>
        </div>
      );
      break;
    case "board.draw_number_line":
      content = (
        <NumberLine min={action.min} max={action.max} marks={action.marks} />
      );
      break;
    case "board.draw_fraction_bars":
      content = <FractionBars fractions={action.fractions} />;
      break;
    case "board.render_custom": {
      const sanitizedSvg = DOMPurify.sanitize(action.svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
      });
      content = (
        <div
          className="custom-svg"
          dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
        />
      );
      break;
    }
    case "board.show_slide":
      content = <img className="slide-image" src={action.slide_ref} alt="Lecture slide" />;
      break;
  }

  return (
    <article className={className} data-element-id={elementId}>
      {content}
    </article>
  );
}
