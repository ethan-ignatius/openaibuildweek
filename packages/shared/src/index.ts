export type BoardRegion =
  | "top"
  | "left"
  | "center"
  | "right"
  | "bottom"
  | "scratch";

export type HighlightStyle = "pulse" | "outline" | "fill";

export type BoardAction =
  | {
      type: "board.write_text";
      region: BoardRegion;
      text: string;
      element_id: string;
    }
  | {
      type: "board.write_math";
      region: BoardRegion;
      latex: string;
      element_id: string;
    }
  | {
      type: "board.plot_function";
      expr: string;
      domain: [number, number];
      element_id: string;
    }
  | {
      type: "board.draw_number_line";
      min: number;
      max: number;
      marks: Array<{ value: number; label?: string }>;
      element_id: string;
    }
  | {
      type: "board.draw_fraction_bars";
      fractions: string[];
      element_id: string;
    }
  | {
      type: "board.render_custom";
      svg: string;
      element_id: string;
    }
  | {
      type: "board.highlight";
      element_id: string;
      style: HighlightStyle;
    }
  | {
      type: "board.unhighlight";
      element_id: string;
    }
  | {
      type: "board.clear";
      region: BoardRegion | "all";
    }
  | {
      type: "board.show_slide";
      slide_ref: string;
    };

export type BoardElement = {
  action: Exclude<
    BoardAction,
    | { type: "board.highlight" }
    | { type: "board.unhighlight" }
    | { type: "board.clear" }
  >;
  highlight?: HighlightStyle;
};

export type BoardServerEvent =
  | { type: "board.snapshot"; elements: BoardElement[] }
  | { type: "board.action"; action: BoardAction }
  | { type: "echo"; payload: unknown }
  | { type: "error"; detail: string };

export interface NarrationSegment {
  text: string;
  language: string;
  highlight_element_id?: string;
}

export interface LectureBeat {
  id: string;
  objective: string;
  board_actions: BoardAction[];
  narration_segments: NarrationSegment[];
  checkpoint_question?: {
    display_text: string;
    options?: string[];
    target_student?: string;
  };
}

export interface LecturePlan {
  id: string;
  title: string;
  source_ref: string;
  beats: LectureBeat[];
}
