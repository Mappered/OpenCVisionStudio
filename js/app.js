'use strict';
/* ==========================================================================
   OpenCVisionStudio (OpenCVS) — Machine Vision IDE (Dark Mode) — application logic
   ========================================================================== */

/* ------------------------------ helpers ------------------------------ */
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/* Time a history entry costs (log -> renderHistory rebuilds the window and
   scrolls it: several milliseconds).  The execution times ask for the work a
   line did, so they subtract it — see "execution times" further down. */
let logCost = 0;
/* operators that draw into a graphics window instead of computing a result:
   HALCON's dev_* settings/drawing operators and the disp_* primitives */
const isDisplayOp = name => /^(dev_|disp_)/.test(String(name || ''));

/* ------------------------------ program data ------------------------------ */
const PROCEDURES = {
  main: {
    lines: [
      "* Blob analysis demo - synthetic chip inspection",
      "read_image (Image, 'printer_chip')",
      "get_image_size (Image, Width, Height)",
      "dev_open_window (0, 0, 640/2, 480/2, 'black', WindowHandle)",
      "dev_display (Image)",
      "threshold (Image, Region, 128, 255)",
      "connection (Region, ConnectedRegions)",
      "select_shape (ConnectedRegions, SelectedRegions, 'area', 'and', 1000, 100000)",
      "count_obj (SelectedRegions, Number)",
      "area_center (SelectedRegions, Area, Row, Column)",
      "dev_display (Image)",
      "dev_display (SelectedRegions)",
      "if (Number > 0)",
      "    disp_message (WindowHandle, 'Found ' + Number + ' parts', 'window', 12, 12, 'green', 'true')",
      "endif",
      "stop ()",
    ],
  },
  detect_features: {
    lines: [
      "* Threshold with fixed limits and connect components",
      "threshold (Image, Region, 100, 255)",
      "connection (Region, ConnectedRegions)",
      "return ()",
    ],
  },
  acquire_demo: {
    lines: [
      "* Webcam acquisition (browser camera via getUserMedia)",
      "* 'DirectShow' is accepted for HALCON syntax compatibility",
      "open_framegrabber ('DirectShow', 0, 0, 0, 0, 0, 0, 'default', 8, 'gray', -1, 'default', 'default', 'default', 'default', 'default', -1, AcqHandle)",
      "grab_image (Image, AcqHandle)",
      "get_image_size (Image, Width, Height)",
      "dev_display (Image)",
      "threshold (Image, Region, 128, 255)",
      "connection (Region, ConnectedRegions)",
      "select_shape (ConnectedRegions, SelectedRegions, 'area', 'and', 1000, 100000)",
      "count_obj (SelectedRegions, Number)",
      "dev_display (Image)",
      "dev_display (SelectedRegions)",
      "close_framegrabber (AcqHandle)",
      "stop ()",
    ],
  },
  metrology_demo: {
    lines: [
      "* Metrology demo - dimensional measurement on the synthetic chip",
      "* (HALCON metrology model: measure regions + robust shape fitting)",
      "read_image (Image, 'printer_chip')",
      "create_metrology_model (MetrologyHandle)",
      "* bright fiducial circle, top-left",
      "add_metrology_object_circle_measure (MetrologyHandle, 92, 120, 24, 12, 8, 1.0, 25, ['measure_transition'], ['all'], CircleIdx)",
      "* die body outline",
      "add_metrology_object_rectangle2_measure (MetrologyHandle, 240, 320, 0, 132, 92, 15, 5, 1.0, 25, ['measure_transition'], ['all'], DieIdx)",
      "* die left edge (vertical caliper line)",
      "add_metrology_object_line_measure (MetrologyHandle, 155, 190, 325, 190, 10, 8, 1.0, 25, ['measure_transition'], ['all'], EdgeIdx)",
      "set_metrology_object_param (MetrologyHandle, 'all', 'min_score', 0.5)",
      "* nominal (model) contour and measure regions are available before apply",
      "set_metrology_model_image_size (MetrologyHandle, 640, 480)",
      "get_metrology_object_model_contour (ModelContours, MetrologyHandle, 'all', 5)",
      "get_metrology_object_measures (MeasureContours, MetrologyHandle, CircleIdx, 'all', MeasureRows, MeasureColumns)",
      "dev_display (Image)",
      "dev_display (ModelContours)",
      "dev_display (MeasureContours)",
      "apply_metrology_model (Image, MetrologyHandle)",
      "* the measures of the last apply: the edges found on the profiles (empty before apply)",
      "get_metrology_object_measures (MeasureContours, MetrologyHandle, CircleIdx, 'all', MeasureRows, MeasureColumns)",
      "get_metrology_object_num_instances (MetrologyHandle, 'all', NumInstances)",
      "get_metrology_model_param (MetrologyHandle, ['image_size'], ModelSize)",
      "* HDevelop result order: (MetrologyHandle, Index, Instance, GenParamName, GenParamValue : Parameter)",
      "get_metrology_object_result (MetrologyHandle, CircleIdx, 0, 'result_type', 'all_param', CircleResult)",
      "get_metrology_object_result (MetrologyHandle, DieIdx, 0, 'result_type', 'all_param', DieResult)",
      "get_metrology_object_result (MetrologyHandle, EdgeIdx, 0, 'result_type', 'all_param', EdgeResult)",
      "get_metrology_object_result (MetrologyHandle, 'all', 'all', 'result_type', 'score', Scores)",
      "* the fitted result contours of every instance as XLD (Resolution 2.0)",
      "get_metrology_object_result_contour (FitContours, MetrologyHandle, 'all', 'all', 2.0)",
      "* refit the measured circle contour directly (fit_*_contour_xld)",
      "get_metrology_object_result_contour (CircleContour, MetrologyHandle, CircleIdx, 0, 1.0)",
      "fit_circle_contour_xld (CircleContour, 'geotukey', -1, 0, 0, 10, 2.0, FitRow, FitColumn, FitRadius, FitStartPhi, FitEndPhi, FitOrder)",
      "stop ()",
    ],
  },
  display_demo: {
    lines: [
      "* Display demo - disp_* primitives, region and XLD generators",
      "* Row = y, Column = x; Phi/Angle are radians measured from the column axis",
      "read_image (Image, 'printer_chip')",
      "get_image_size (Image, Width, Height)",
      "dev_open_window (0, 0, Width/2, Height/2, 'black', WindowHandle)",
      "dev_update_window ('off')",
      "dev_display (Image)",
      "* --- disp_* drawing primitives: drawn with the current dev_set_* settings",
      "dev_set_draw ('margin')",
      "dev_set_line_width (2)",
      "dev_set_color ('green')",
      "disp_rectangle1 (WindowHandle, Height*0.08, Width*0.06, Height*0.42, Width*0.44)",
      "disp_rectangle2 (WindowHandle, Height*0.25, Width*0.72, rad(30), Width*0.16, Height*0.17)",
      "disp_circle (WindowHandle, Height*0.72, Width*0.22, Width*0.12)",
      "disp_ellipse (WindowHandle, Height*0.72, Width*0.70, rad(20), Width*0.16, Height*0.16)",
      "disp_line (WindowHandle, Height*0.05, Width*0.55, Height*0.40, Width*0.95)",
      "disp_arrow (WindowHandle, Height*0.92, Width*0.08, Height*0.92, Width*0.92, 16)",
      "disp_cross (WindowHandle, Height*0.5, Width*0.5, 40, rad(45))",
      "disp_polygon (WindowHandle, [Height*0.44, Height*0.44, Height*0.58], [Width*0.62, Width*0.92, Width*0.77])",
      "* --- region generators: a region built from geometric parameters",
      "dev_set_color ('cyan')",
      "gen_rectangle1 (Rect1, Height*0.08, Width*0.06, Height*0.42, Width*0.44)",
      "gen_rectangle2 (Rect2, Height*0.25, Width*0.72, rad(30), Width*0.16, Height*0.17)",
      "gen_circle (Circle, Height*0.72, Width*0.22, Width*0.12)",
      "gen_ellipse (Ellipse, Height*0.72, Width*0.70, rad(20), Width*0.16, Height*0.16)",
      "gen_region_line (LineRegion, Height*0.05, Width*0.55, Height*0.40, Width*0.95)",
      "gen_region_polygon_filled (PolyFilled, [Height*0.44, Height*0.44, Height*0.58], [Width*0.62, Width*0.92, Width*0.77])",
      "gen_region_polygon (PolyOutline, [Height*0.44, Height*0.44, Height*0.58], [Width*0.62, Width*0.92, Width*0.77])",
      "disp_region (PolyFilled, WindowHandle)",
      "disp_region (PolyOutline, WindowHandle)",
      "* --- XLD generators: the same geometry as sub-pixel contours",
      "dev_set_color ('yellow')",
      "gen_cross_contour_xld (CrossContour, Height*0.5, Width*0.5, 40, rad(45), CenterRow, CenterCol, AngleOut)",
      "gen_rectangle2_contour_xld (RectContour, Height*0.25, Width*0.72, rad(30), Width*0.16, Height*0.17)",
      "gen_contour_region_xld (PolyFilled, PolyContour, 'border', 'border', -1, 0)",
      "disp_obj (CrossContour, WindowHandle)",
      "disp_obj (RectContour, WindowHandle)",
      "disp_obj (PolyContour, WindowHandle)",
      "* --- a second window: a window handle of 0 means the active window",
      "dev_open_window (Height/2, 0, Width/2, Height/2, 'black', Win2)",
      "dev_set_color ('white')",
      "disp_image (Image, Win2)",
      "disp_circle (0, Height*0.5, Width*0.5, Width*0.10)",
      "disp_cross (0, Height*0.5, Width*0.5, Width*0.20, 0)",
      "disp_message (Win2, 'disp_* primitives - window handle 0 = active window', 'window', 12, 12, 'green', 'true')",
      "dev_update_window ('on')",
      "stop ()",
    ],
  },
};

const CONTROL_KW = /\b(if|elseif|else|endif|for|endfor|while|endwhile|try|catch|endtry|return|exit|stop)\b/;

/* The program the IDE starts with is a sample (main plus the demo procedures).
   Its text is remembered here so that a saved program file can leave out every
   procedure that still holds the sample text unchanged: saving an .odev should
   write your program, not the demo operators that came with the IDE. */
const PROGRAM_BUILTIN = Object.fromEntries(
  Object.entries(PROCEDURES).map(([n, p]) => [n, p.lines.join('\n').trim()]));
const isBuiltinDemo = name => {
  const p = PROCEDURES[name];
  return !!p && PROGRAM_BUILTIN[name] !== undefined &&
    p.lines.join('\n').trim() === PROGRAM_BUILTIN[name];
};

/* Operator metadata.  Every parameter is
     [Name, 'input'|'output', 'iconic'|'control']
   and may carry a 4th element: the default value HDevelop fills in for this
   (optional) parameter.  Entering an operator writes those defaults into the
   program and leaves the other arguments as placeholders to tab through
   (opInsertEntries/opArgText); the Parameters tab shows the default for an
   argument the program line does not pass. */
const OPINFO = {
  read_image: {
    params: [['Image', 'output', 'iconic'], ['FileName', 'input', 'control']],
    desc: `Reads an image from a file into <code>Image</code>. The demo program
           reads the built-in <code>'printer_chip'</code> image, which is
           synthesized in the browser. Use <b>Load file…</b> in the Parameters tab
           to read a real file from disk (PNG, JPG, BMP, GIF, TIFF, WebP): the file
           is loaded into this session, its name is written into <code>FileName</code>
           and the image appears in the graphics window immediately. Every loaded
           file stays available in the <b>Image file</b> list. Like the demo image,
           files are converted to gray, byte — the pixel format the operators expect.`,
  },
  get_image_size: {
    params: [['Image', 'input', 'iconic'], ['Width', 'output', 'control'], ['Height', 'output', 'control']],
    desc: 'Returns the size of the image in <code>Width</code> and <code>Height</code>.',
  },
  dev_open_window: {
    params: [['Row', 'input', 'control', '0'], ['Column', 'input', 'control', '0'],
             ['Width', 'input', 'control', '512'], ['Height', 'input', 'control', '512'],
             ['Background', 'input', 'control', "'black'"], ['WindowHandle', 'output', 'control']],
    desc: `Opens a new floating graphics window. Like in HDevelop the new window is
           <b>active</b> immediately (see the active-window lamp in the toolbar):
           dev_display and the automatically displayed operator results are output
           to it. Background: colour name, gray value 0…255, packed RGB or -1.`,
  },
  dev_close_window: {
    params: [],
    desc: `Closes the <b>active</b> graphics window. Like in HDevelop only floating
           windows are closed; the docked Graphics Window of the IDE cannot be
           destroyed and is cleared instead (with a warning).`,
  },
  dev_set_window: {
    params: [['WindowHandle', 'input', 'control']],
    desc: 'Makes the given graphics window the active output window (equivalent to clicking the active-window lamp).',
  },
  dev_get_window: {
    params: [['WindowHandle', 'output', 'control']],
    desc: 'Returns the handle of the active graphics window. The docked Graphics Window (handle 1) always exists, so a valid handle is always returned.',
  },
  dev_clear_window: {
    params: [],
    desc: 'Clears the contents <b>and the display history</b> of the active graphics window; the display parameters are not affected.',
  },
  close_window: {
    params: [['WindowHandle', 'input', 'control']],
    desc: 'HALCON form of dev_close_window: closes the graphics window with the given handle (error for an unknown handle).',
  },
  dev_display: {
    params: [['Object', 'input', 'iconic']],
    desc: `Displays an iconic object in the active graphics window. A tuple of
           objects is displayed in one call. Displaying a full image clears the
           window history, regions and XLD are added on top of it — exactly like
           HDevelop's graphics window (double-clicking a variable in the variable
           window does the same). HDevelop only displays the first channel;
           this build has byte images only.`,
  },
  dev_set_color: {
    params: [['ColorName', 'input', 'control']],
    desc: `Sets the colour used for region outlines, XLD contours and messages:
           a colour name (<code>'red'</code>, <code>'green'</code>, &hellip;) or
           <code>'#rrggbb'</code> / <code>'#rrggbbaa'</code>. The setting stays in
           effect until it is changed and is inherited by windows opened
           afterwards; an empty tuple restores the default colours.`,
  },
  dev_set_colored: {
    params: [['NumColors', 'input', 'control', '6']],
    desc: `Displays regions with 3, 6 or 12 colours (instead of dev_set_color's
           single colour). <code>NumColors</code> is rounded to 6 if it is not
           3, 6 or 12.`,
  },
  dev_set_draw: {
    params: [['Mode', 'input', 'control', "'fill'"]],
    desc: `Sets the region fill mode: <code>'fill'</code> (default) fills regions,
           <code>'margin'</code> draws their outline only (affected by
           dev_set_color and dev_set_line_width).`,
  },
  dev_set_line_width: {
    params: [['LineWidth', 'input', 'control', '1']],
    desc: 'Sets the line width of region outlines and XLD contours (integer &ge; 1).',
  },
  dev_set_part: {
    params: [['Row1', 'input', 'control'], ['Column1', 'input', 'control'],
             ['Row2', 'input', 'control'], ['Column2', 'input', 'control']],
    desc: `Sets the image part that is displayed in the active window. If
           <code>Row1 &gt; Row2</code> (or <code>Column1 &gt; Column2</code>) the
           zooming of that dimension is reset. The part is reset automatically when
           an image with a different size is displayed.`,
  },
  dev_update_window: {
    params: [['Mode', 'input', 'control', "'on'"]],
    desc: `<code>'on'</code> (default): the iconic results of operators are displayed
           automatically in the active window, like in HDevelop.
           <code>'off'</code>: only explicitly displayed objects (dev_display,
           double-click in the variable window) are shown.`,
  },
  dev_set_paint: {
    params: [['Mode', 'input', 'control', "'default'"]],
    desc: `Sets the paint mode <code>'default'</code> | <code>'3d_plot'</code> |
           <code>'histogram'</code> | <code>'bars'</code>. Only the default mode is
           supported in this build; other modes are accepted with a warning
           (use the 3D plot / histogram panels of the graphics window instead).`,
  },
  dev_set_lut: {
    params: [['LookUpTable', 'input', 'control', "'default'"]],
    desc: 'Sets the colour lookup table ("default", "linear", "inverse", …). Not supported in this build — accepted with a warning.',
  },
  threshold: {
    params: [['Image', 'input', 'iconic'], ['Region', 'output', 'iconic'],
             ['MinGray', 'input', 'control', '128'], ['MaxGray', 'input', 'control', '255']],
    desc: 'Segments a region of gray values <code>MinGray</code> &hellip; <code>MaxGray</code> (HALCON defaults 128/255).',
  },
  connection: {
    params: [['Region', 'input', 'iconic'], ['ConnectedRegions', 'output', 'iconic']],
    desc: 'Computes the connected components of a region.',
  },
  select_shape: {
    params: [['Regions', 'input', 'iconic'], ['SelectedRegions', 'output', 'iconic'],
             ['Features', 'input', 'control', "'area'"], ['Operation', 'input', 'control', "'and'"],
             ['Min', 'input', 'control', '150'], ['Max', 'input', 'control', '99999']],
    desc: 'Selects regions with the given shape feature (HALCON defaults <code>area</code>, <code>and</code>, 150, 99999).',
  },
  count_obj: {
    params: [['Objects', 'input', 'iconic'], ['Number', 'output', 'control']],
    desc: 'Counts the number of objects in a tuple.',
  },
  area_center: {
    params: [['Regions', 'input', 'iconic'], ['Area', 'output', 'control'],
             ['Row', 'output', 'control'], ['Column', 'output', 'control']],
    desc: 'Area and centroid of regions.',
  },
  /* ---- region generation (gen_*) ----
     These create a region from geometric parameters instead of from an image.
     The result is a region object like threshold's, so it can be displayed,
     fed into connection/select_shape or reduced to a contour. */
  gen_rectangle1: {
    params: [['Region', 'output', 'iconic'], ['Row1', 'input', 'control'],
             ['Column1', 'input', 'control'], ['Row2', 'input', 'control'],
             ['Column2', 'input', 'control']],
    desc: `Creates a filled axis-parallel rectangle region. The two corners are
           inclusive and may be given in any order (they are normalized).
           Tuples create one rectangle per element.`,
  },
  gen_rectangle2: {
    params: [['Rectangle', 'output', 'iconic'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control'], ['Phi', 'input', 'control'],
             ['Length1', 'input', 'control'], ['Length2', 'input', 'control']],
    desc: `Creates a filled rectangle region with centre (<code>Row</code>,
           <code>Column</code>) and <em>half</em> side lengths
           <code>Length1</code> / <code>Length2</code>, rotated by
           <code>Phi</code> (radians, measured from the column axis).`,
  },
  gen_circle: {
    params: [['Circle', 'output', 'iconic'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control'], ['Radius', 'input', 'control']],
    desc: 'Creates a filled circle region.',
  },
  gen_ellipse: {
    params: [['Ellipse', 'output', 'iconic'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control'], ['Phi', 'input', 'control'],
             ['Radius1', 'input', 'control'], ['Radius2', 'input', 'control']],
    desc: `Creates a filled ellipse region with centre (<code>Row</code>,
           <code>Column</code>), half axes <code>Radius1</code> /
           <code>Radius2</code> and orientation <code>Phi</code> (radians,
           measured from the column axis).`,
  },
  gen_region_line: {
    params: [['RegionLines', 'output', 'iconic'], ['BeginRow', 'input', 'control'],
             ['BeginCol', 'input', 'control'], ['EndRow', 'input', 'control'],
             ['EndCol', 'input', 'control']],
    desc: `Creates a region made of 1-pixel-wide lines from
           (<code>BeginRow</code>, <code>BeginCol</code>) to
           (<code>EndRow</code>, <code>EndCol</code>); the endpoints belong to the
           line. Tuples create several lines in one region.`,
  },
  gen_region_polygon: {
    params: [['Region', 'output', 'iconic'], ['Row', 'input', 'control'],
             ['Col', 'input', 'control']],
    desc: `Creates a region from the outline of the polygon through the points
           (<code>Row</code>, <code>Col</code>); the polygon is closed
           automatically. The point lists are given as tuples, e.g. [10, 50, 50]
           and [20, 20, 80].`,
  },
  gen_region_polygon_filled: {
    params: [['Region', 'output', 'iconic'], ['Row', 'input', 'control'],
             ['Col', 'input', 'control']],
    desc: 'Like gen_region_polygon, but the polygon is filled.',
  },
  disp_message: {
    params: [['WindowHandle', 'input', 'control'], ['String', 'input', 'control'],
             ['CoordSystem', 'input', 'control', "'window'"], ['Row', 'input', 'control', '12'],
             ['Column', 'input', 'control', '12'], ['Color', 'input', 'control', "'green'"],
             ['Box', 'input', 'control', "'true'"]],
    desc: `Displays a message in a graphics window (<code>CoordSystem 'window'</code>
           or <code>'image'</code>; <code>Row</code>/<code>Column</code> default to 12,
           <code>Color</code> to <code>'green'</code>, <code>Box</code> to
           <code>'true'</code>). The message stays until the window is cleared or a
           full image is displayed.`,
  },
  /* ---- drawing primitives (disp_*) ----
     Like disp_message these draw into a window and yield no iconic result, so
     they are kept in the window's display history and redrawn on resize. They
     honour dev_set_color, dev_set_draw and dev_set_line_width; coordinates are
     image coordinates (Row = y, Column = x).  A window handle of 0 (or an empty
     argument) means the active window, and coordinate tuples draw one primitive
     per element (a single value is used for all of them). */
  disp_cross: {
    params: [['WindowHandle', 'input', 'control'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control'], ['Size', 'input', 'control', '20'],
             ['Angle', 'input', 'control', '0']],
    desc: `Draws crosses of total length <code>Size</code> centred on the given
           points; <code>Angle</code> (radians) rotates the cross
           (<code>0</code> gives +, <code>rad(45)</code> gives &times;).`,
  },
  disp_line: {
    params: [['WindowHandle', 'input', 'control'], ['Row1', 'input', 'control'],
             ['Column1', 'input', 'control'], ['Row2', 'input', 'control'],
             ['Column2', 'input', 'control']],
    desc: 'Draws lines from (<code>Row1</code>, <code>Column1</code>) to (<code>Row2</code>, <code>Column2</code>).',
  },
  disp_arrow: {
    params: [['WindowHandle', 'input', 'control'], ['Row1', 'input', 'control'],
             ['Column1', 'input', 'control'], ['Row2', 'input', 'control'],
             ['Column2', 'input', 'control'], ['Size', 'input', 'control', '20']],
    desc: `Draws arrows ending in the point (<code>Row2</code>,
           <code>Column2</code>) with an arrow head of length <code>Size</code>.`,
  },
  disp_circle: {
    params: [['WindowHandle', 'input', 'control'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control'], ['Radius', 'input', 'control']],
    desc: 'Draws circles (filled, unless dev_set_draw is set to \'margin\').',
  },
  disp_ellipse: {
    params: [['WindowHandle', 'input', 'control'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control'], ['Phi', 'input', 'control'],
             ['Radius1', 'input', 'control'], ['Radius2', 'input', 'control']],
    desc: `Draws ellipses with half axes <code>Radius1</code> /
           <code>Radius2</code>, rotated by <code>Phi</code> (radians, measured
           from the column axis).`,
  },
  disp_rectangle1: {
    params: [['WindowHandle', 'input', 'control'], ['Row1', 'input', 'control'],
             ['Column1', 'input', 'control'], ['Row2', 'input', 'control'],
             ['Column2', 'input', 'control']],
    desc: 'Draws axis-parallel rectangles (corners may be given in any order).',
  },
  disp_rectangle2: {
    params: [['WindowHandle', 'input', 'control'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control'], ['Phi', 'input', 'control'],
             ['Length1', 'input', 'control'], ['Length2', 'input', 'control']],
    desc: `Draws rectangles with centre (<code>Row</code>, <code>Column</code>)
           and <em>half</em> side lengths <code>Length1</code> /
           <code>Length2</code>, rotated by <code>Phi</code> (radians).`,
  },
  disp_polygon: {
    params: [['WindowHandle', 'input', 'control'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control']],
    desc: `Draws the (closed) polygon through the points <code>Row</code> /
           <code>Column</code>, both given as tuples.`,
  },
  disp_obj: {
    params: [['Object', 'input', 'iconic'], ['WindowHandle', 'input', 'control']],
    desc: `HALCON's object-first form of dev_display: displays an image, region
           or XLD in the given window (0 or an empty argument = active window).
           <code>disp_region</code> and <code>disp_image</code> are accepted as
           spellings of the same operator.`,
  },
  disp_region: {
    params: [['Object', 'input', 'iconic'], ['WindowHandle', 'input', 'control']],
    desc: 'Displays a region — same as dev_display.',
  },
  disp_image: {
    params: [['Object', 'input', 'iconic'], ['WindowHandle', 'input', 'control']],
    desc: `Displays an image (it becomes the window's base image, clearing the
           display history) — same as dev_display.`,
  },
  open_framegrabber: {
    params: [['Name', 'input', 'control'], ['HorizontalOffset', 'input', 'control'],
             ['VerticalOffset', 'input', 'control'], ['ImageWidth', 'input', 'control'],
             ['ImageHeight', 'input', 'control'], ['StartRow', 'input', 'control'],
             ['StartColumn', 'input', 'control'], ['Field', 'input', 'control'],
             ['BitsPerChannel', 'input', 'control'], ['ColorType', 'input', 'control'],
             ['Generic', 'input', 'control'], ['ExternalTrigger', 'input', 'control'],
             ['CameraType', 'input', 'control'], ['Device', 'input', 'control'],
             ['Port', 'input', 'control'], ['LineIn', 'input', 'control'],
             ['AcqHandle', 'output', 'control']],
    desc: `Opens a frame grabber. In this browser build the HALCON interface name
           ('DirectShow', 'GigEVision', ...) is accepted for compatibility, while
           acquisition runs through the browser camera API (getUserMedia).`,
  },
  grab_image: {
    params: [['Image', 'output', 'iconic'], ['AcqHandle', 'input', 'control']],
    desc: 'Grabs an image synchronously from the acquisition device.',
  },
  grab_image_async: {
    params: [['Image', 'output', 'iconic'], ['AcqHandle', 'input', 'control'],
             ['MaxDelay', 'input', 'control', '-1']],
    desc: 'Grabs an image asynchronously (non-blocking alias of grab_image here).',
  },
  close_framegrabber: {
    params: [['AcqHandle', 'input', 'control']],
    desc: 'Closes the frame grabber and releases the camera.',
  },
  /* ---- operators of imported HDevelop programs ---------------------------
     The part of the system/file operator families that HDevelop example
     programs use most (dev_update_on/off, list_image_files, parse_filename,
     the text file operators) plus the image/region/geometry operators of the
     classic "find the object, measure it" workflow. */
  dev_update_on: {
    params: [],
    desc: `Turns the automatic display of iconic operator results in the active
           graphics window on — the same as
           <code>dev_update_window('on')</code>.`,
  },
  dev_update_off: {
    params: [],
    desc: `Turns the automatic display off, so only explicitly displayed objects
           become visible — the same as
           <code>dev_update_window('off')</code>. Used in measurement loops,
           where only the final result is displayed.`,
  },
  list_image_files: {
    params: [['ImageDirectory', 'input', 'control'],
             ['Extensions', 'input', 'control'], ['Options', 'input', 'control'],
             ['ImageFiles', 'output', 'control']],
    desc: `Returns the image files that read_image can read as a string tuple,
           sorted by name. <code>ImageDirectory</code> is read when the page is
           served over HTTP (a local server lists a directory — use the
           "Folder…" button or "Load folder…" for the folder of an opened
           program, which a page cannot otherwise see) or after a folder has
           been granted with the File System Access API. With no folder
           available it falls back to the files loaded in the Operator Window.
           <code>Extensions</code> selects which file types count,
           <code>Options</code> is accepted for compatibility.`,
  },
  mean_image: {
    params: [['Image', 'input', 'iconic'], ['ImageMean', 'output', 'iconic'],
             ['MaskWidth', 'input', 'control', '9'], ['MaskHeight', 'input', 'control', '9']],
    desc: `Smooths <code>Image</code> with a mean (box) filter of size
           <code>MaskWidth</code> &times; <code>MaskHeight</code> and returns the
           smoothed image. The usual preprocessing step before
           dyn_threshold.`,
  },
  dyn_threshold: {
    params: [['OrigImage', 'input', 'iconic'], ['ThresholdImage', 'input', 'iconic'],
             ['RegionDynThresh', 'output', 'iconic'], ['Offset', 'input', 'control', '5'],
             ['LightDark', 'input', 'control', "'light'"]],
    desc: `Segments the pixels of <code>OrigImage</code> whose gray value differs
           from the locally smoothed <code>ThresholdImage</code> by more than
           <code>Offset</code>. <code>LightDark</code> selects what is returned:
           <code>'light'</code>, <code>'dark'</code>, <code>'equal'</code> or
           <code>'not_equal'</code>. HALCON's defaults are <code>Offset</code> = 5
           and <code>LightDark</code> = <code>'light'</code>.`,
  },
  select_shape_std: {
    params: [['Regions', 'input', 'iconic'], ['SelectedRegions', 'output', 'iconic'],
             ['ShapeFeature', 'input', 'control', "'max_area'"], ['Percent', 'input', 'control', '70']],
    desc: `Selects regions by a standard shape: <code>'max_area'</code> (the
           largest region, as in HALCON without using <code>Percent</code>),
           <code>'rectangle1'</code> / <code>'rectangle2'</code> (a region whose
           area differs from its enclosing axis&#8209;parallel resp. smallest
           rotated rectangle by more than <code>Percent</code> percent), plus
           <code>'min_area'</code> (the smallest) and <code>'original'</code>
           (all regions) as extensions.`,
  },
  smallest_rectangle2: {
    params: [['Regions', 'input', 'iconic'], ['Row', 'output', 'control'],
             ['Column', 'output', 'control'], ['Phi', 'output', 'control'],
             ['Length1', 'output', 'control'], ['Length2', 'output', 'control']],
    desc: `Smallest enclosing rectangle of every input region: the centre
           (<code>Row</code>, <code>Column</code>), the orientation
           <code>Phi</code> (radians, measured from the column axis) and the
           <em>half</em> side lengths <code>Length1</code> &ge;
           <code>Length2</code>.`,
  },
  distance_pp: {
    params: [['Row1', 'input', 'control'], ['Column1', 'input', 'control'],
             ['Row2', 'input', 'control'], ['Column2', 'input', 'control'],
             ['Distance', 'output', 'control']],
    desc: `Distance between the points (<code>Row1</code>, <code>Column1</code>)
           and (<code>Row2</code>, <code>Column2</code>). Coordinates may be
           tuples, then the result is a tuple as well.`,
  },
  angle_lx: {
    params: [['Row1', 'input', 'control'], ['Column1', 'input', 'control'],
             ['Row2', 'input', 'control'], ['Column2', 'input', 'control'],
             ['Angle', 'output', 'control']],
    desc: `Angle of the line from (<code>Row1</code>, <code>Column1</code>) to
           (<code>Row2</code>, <code>Column2</code>) with respect to the
           horizontal axis, in radians (&minus;&pi; … &pi;).`,
  },
  parse_filename: {
    params: [['FileName', 'input', 'control'], ['BaseName', 'output', 'control'],
             ['Extension', 'output', 'control'], ['Directory', 'output', 'control']],
    desc: `Splits a file name into its base name, its extension
           (including the dot) and the directory (including the trailing
           separator).`,
  },
  open_file: {
    params: [['FileName', 'input', 'control'], ['FileType', 'input', 'control'],
             ['FileHandle', 'output', 'control']],
    desc: `Opens a text file for writing and returns a file handle. A browser
           page cannot write to disk, so this build collects the written text
           and offers it as a download when the file is closed.`,
  },
  fwrite_string: {
    params: [['FileHandle', 'input', 'control'], ['String', 'input', 'control']],
    desc: `Appends the text <code>String</code> to an open file, including the
           escapes <code>\\n</code> and <code>\\t</code>; a control tuple is
           written one element per line.`,
  },
  close_file: {
    params: [['FileHandle', 'input', 'control']],
    desc: `Closes an open file. In this browser build the text collected by
           fwrite_string is offered as a download.`,
  },
  stop:     { params: [], desc: 'Stops program execution.' },
  return:   { params: [], desc: 'Returns from the current procedure.' },
  if:       { params: [['Condition', 'input', 'control']], desc: 'Conditional statement.' },
  endif:    { params: [], desc: 'End of conditional statement.' },
};
Object.assign(OPINFO, METROLOGY_OPINFO);

/* The values a control parameter can take, shown as a dropdown in the Parameters
   tab so a keyword is picked instead of typed.  Only the values THIS BUILD
   implements are listed — the operator rejects the others (HALCON knows many
   more: select_shape has 34 further region features, fit_ellipse_contour_xld
   four further algorithms …).  Keyed by "operator.Parameter", because the same
   parameter name means different things in different operators; a value that is
   a function is evaluated on use (the colour names are defined further down). */
const colorValues = () => Object.keys(DEV_NAMED);
const PARAM_VALUES = {
  /* display parameters */
  'dev_open_window.Background': colorValues,
  'dev_set_color.ColorName': () => ['[]', ...colorValues()],
  'dev_set_draw.Mode': ['fill', 'margin'],
  'dev_set_colored.NumColors': ['3', '6', '12'],
  'dev_update_window.Mode': ['on', 'off'],
  'dev_set_paint.Mode': ['default', '3d_plot', 'histogram', 'bars'],
  'disp_message.CoordSystem': ['window', 'image'],
  'disp_message.Color': colorValues,
  'disp_message.Box': ['true', 'false'],
  /* segmentation */
  'select_shape.Features': ['area', 'row', 'column', 'row1', 'row2',
    'column1', 'column2', 'width', 'height', 'ratio'],
  'select_shape.Operation': ['and', 'or'],
  'select_shape_std.ShapeFeature': ['max_area', 'rectangle1', 'rectangle2',
    'min_area', 'original'],
  'dyn_threshold.LightDark': ['light', 'dark', 'equal', 'not_equal'],
  /* files */
  'open_file.FileType': ['output'],
  /* XLD */
  'gen_circle_contour_xld.PointOrder': ['positive', 'negative'],
  'gen_ellipse_contour_xld.PointOrder': ['positive', 'negative'],
  'gen_contour_region_xld.Mode': ['border', 'border_holes'],
  'fit_circle_contour_xld.Algorithm': ['geotukey', 'geometric', 'geohuber',
    'algebraic', 'atukey', 'ahuber'],
  'fit_ellipse_contour_xld.Algorithm': ['fitzgibbon', 'ftukey', 'fhuber',
    'focpoints', 'fptukey', 'fphuber', 'geometric', 'geotukey', 'geohuber', 'voss'],
  'fit_line_contour_xld.Algorithm': ['tukey', 'huber', 'drop', 'gauss', 'regression'],
  'fit_rectangle2_contour_xld.Algorithm': ['tukey', 'huber', 'regression'],
  /* metrology */
  'get_metrology_object_measures.Transition': ['all', 'positive', 'negative'],
};

/* the values of `param` of `op`, or null when it has no fixed set */
function paramValues(op, param) {
  const v = PARAM_VALUES[`${op}.${param}`];
  const list = v ? (typeof v === 'function' ? v() : v) : null;
  return list && list.length ? list : null;
}

/* how a value of a list is written into the program: a HALCON keyword is a
   string literal ('fill'), a number and a tuple are not (3, [1, 2], []), and a
   bare word that is neither (a file name) is a string again ('benchs.png') */
const valueLiteral = v => {
  const s = String(v);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return `'${s}'`;
  return /^[-+.\d]/.test(s) || /^['"[]/.test(s) ? s : `'${s}'`;
};

/* a value inside an HTML attribute — esc() does not cover the quote */
const attr = s => esc(String(s)).replace(/"/g, '&quot;');

/* Entering an operator writes its call the way HDevelop does: parameters with a
   documented default are filled in with it, the remaining ones are written as
   placeholders (their name) and the caret is placed on the first of them, so
   Tab/Enter steps through the arguments that still have to be chosen.

   With a context ({ proc, line } of the call that is being written) the iconic
   inputs are filled from the program as well: each one takes the most recent
   iconic result of the preceding lines whose type fits.  That is what turns

     read_image (Image, 'printer_chip')            -> Image
     mean_image (Image, ImageMean, 9, 9)           -> ImageMean
     dyn_threshold (Image, ImageMean, RegionDynThresh, 5, 'light')

   into the arguments the completion and the operator input line write. */
function opInsertEntries(op, ctx) {
  const info = OPINFO[op];
  if (!info) return [];
  const linked = ctx ? linkIconicInputs(op, iconicResultsBefore(ctx.proc, ctx.line)) : [];
  return info.params.map((p, i) => {
    if (linked[i]) return { name: p[0], txt: linked[i], placeholder: false, linked: true };
    return { name: p[0], txt: p.length > 3 ? String(p[3]) : p[0], placeholder: p.length <= 3 };
  });
}

/* The data type of an iconic value: 'image', 'region' or 'xld'.  Every HALCON
   parameter is named after what it holds, so the name carries the type, and the
   operator name covers the generic ones ('Cross', 'Rectangle'); a value the
   program has already produced knows its type for certain.  All names are
   tested together, type by type, so gen_cross_contour_xld's `Cross` comes out
   as a contour rather than as a region. */
function iconicKind(rec, ...names) {
  if (rec && rec.kind) return rec.kind;
  const s = names.map(n => String(n == null ? '' : n)).join(' ');
  if (/contour|xld/i.test(s)) return 'xld';
  if (/image/i.test(s)) return 'image';
  if (/region|rectangle|circle|ellipse|polygon|cross|mask/i.test(s)) return 'region';
  return '';
}

/* May a value of type `have` be handed to an input of type `want`?  An unknown
   type on either side fits, because HALCON variables are untyped at the source
   level (`Circle` may well hold a contour). */
const iconicKindFits = (want, have) => !want || !have || want === have;

/* The iconic results of the lines before `line` (1-based, within `proc`),
   newest first and without duplicates.  Only operator calls count — parseLine
   understands nothing else — which is exactly what a following line can link
   to. */
function iconicResultsBefore(proc, line) {
  const out = [], seen = new Set();
  const L = linesOf(proc);
  for (let i = Math.min(line, L.length + 1) - 2; i >= 0; i--) {
    const p = parseLine(L[i]);
    if (!p) continue;
    const info = OPINFO[p.op];
    if (!info) continue;
    p.args.forEach((a, k) => {
      const param = info.params[k];
      if (!param || param[1] !== 'output' || param[2] !== 'iconic') return;
      if (seen.has(a) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) return;
      seen.add(a);
      out.push({ name: a, kind: iconicKind(state.iconic.get(a), param[0], p.op) });
    });
  }
  return out;
}

/* Fill the iconic inputs of `op` from those results.  The inputs are served
   from the last one backwards, so the newest result lands on the input nearest
   to its producer: dyn_threshold's ThresholdImage is the filtered image of the
   line above, while OrigImage keeps the older original.  An input without a
   fitting, unused result keeps its name as placeholder. */
function linkIconicInputs(op, results) {
  const info = OPINFO[op];
  if (!info) return [];
  const fill = [], used = new Set();
  for (let i = info.params.length - 1; i >= 0; i--) {
    const p = info.params[i];
    if (p[1] !== 'input' || p[2] !== 'iconic') continue;
    const want = iconicKind(null, p[0]);
    const hit = results.find(r => !used.has(r.name) && iconicKindFits(want, r.kind));
    if (!hit) continue;
    used.add(hit.name);
    fill[i] = hit.name;
  }
  return fill;
}

/* argument text plus the offset of every argument inside it */
function opArgText(op, ctx) {
  const entries = opInsertEntries(op, ctx);
  let off = 0;
  const starts = entries.map(e => { const s = off; off += e.txt.length + 2; return s; });
  return { entries, starts, text: entries.map(e => e.txt).join(', ') };
}

/* ------------------------------ global state ------------------------------ */
const state = {
  proc: 'main',
  cursor: 1,          // selected line (1-based)
  /* The program counter: the line the program is suspended at AND the
     procedure that line belongs to.  The Program Window can show a procedure
     other than the one the program runs in — Alt+Enter browses into a call —
     and a bare line number would then draw the green ▶ marker on whatever line
     of the *shown* procedure happens to have that number.  The setter keeps the
     owner in step, so no caller has to remember it. */
  pcLine: null,
  pcProc: null,
  get pc() { return state.pcLine; },
  set pc(v) { state.pcLine = v; state.pcProc = v === null ? null : state.proc; },
  running: false,
  stopRequested: false,
  breakpoints: new Set(),     // "proc:line"
  iconic: new Map(),          // name -> { kind, ... }
  ctrl: new Map(),            // name -> { value, type }
  history: [],
  errors: [],
  varsTab: 'iconic',
  opTab: 'parameters',
  histTab: 'history',
  selectedVar: null,
  selectedCtrl: null,
  watch: new Set(),           // watched variable names (persist across runs)
  plotVar: null,              // control variable shown in the plot panel
  updateWindow: true,         // dev_update_window: display operator results automatically
  unknownOps: new Set(),      // operators reported as not implemented (once per name)
  errorLine: null,            // { proc, line, text } of the line that stopped the run
  times: new Map(),           // proc -> [{ text, ms }] per line: the last execution's times
  showTimes: true,            // the gutter shows those times (Visualization ▸ Execution Times)
  /* Feature Inspection window (Visualization ▸ Feature Inspection): the region
     element or XLD contour picked in a graphics window, which features are
     checked in the tree, and the gauge ranges the user has set. */
  featInsp: {
    name: null, id: 1, handle: null,
    checked: new Set(['area', 'width', 'height', 'ratio', 'min', 'max', 'mean']),
    ranges: new Map(),        // feature -> [min, max] of its gauge
    minMax: false,            // the gauge shows its limits as text
  },
  progFile: 'program.odev',   // file name of the current program (Open/Save Program)
  /* control flow of the structured statements: the program counter normally
     advances to the next executable line, but for/while/endfor/if/endif and
     procedure calls jump.  `nextPc` is undefined for "just go on". */
  nextPc: undefined,
  frames: [],                 // call stack of user procedures
  loops: [],                  // open for/while blocks of the running procedure
  branches: new Map(),        // "proc:ifLine" -> { endif, taken }
};

/* HALCON control-flow keywords and statements: not operators, never reported
   as "not implemented". */
const HD_KEYWORDS = new Set(['if', 'else', 'elseif', 'endif', 'for', 'endfor', 'while', 'endwhile',
  'repeat', 'until', 'break', 'continue', 'return', 'stop', 'exit', 'try', 'catch', 'endtry',
  'switch', 'case', 'endswitch', 'default', 'global', 'throw', 'assert', 'comment']);

/* statements the processor executes itself: not operator calls (mostly without
   parentheses), but they must be stepped onto all the same — every other
   keyword (global, comment, assert …) is simply skipped. */
const CONTROL_WORDS = new Set(['if', 'elseif', 'else', 'endif', 'for', 'endfor', 'while',
  'endwhile', 'repeat', 'until', 'break', 'continue', 'return', 'stop', 'exit']);

const linesOf = proc => PROCEDURES[proc].lines;
const lineText = (proc, n) => linesOf(proc)[n - 1];

function parseLine(text) {
  const m = text.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*$/);
  if (!m) return null;
  const args = [];
  let cur = '', q = false, depth = 0;
  for (const ch of m[2]) {
    if (ch === "'") q = !q;
    if (!q) {                                  // HALCON tuples: [a, b] — commas inside brackets don't separate args
      if (ch === '[') depth++;
      else if (ch === ']') depth = Math.max(0, depth - 1);
    }
    if (ch === ',' && !q && depth === 0) { args.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim() !== '' || args.length) args.push(cur.trim());
  return { op: m[1], args };
}
const isComment  = t => /^\s*\*/.test(t);

/* ==========================================================================
   CONTROL EXPRESSIONS
   The right-hand sides of assignments, the bounds of for loops and the
   conditions of if/while/until statements: numbers, strings, tuples,
   + - * / %, comparisons, and/or/not, |Tuple|, Tuple[i] and the intrinsic
   functions.  A value is a plain JS number, string or array of them — exactly
   what a HALCON tuple is.  Nothing is ever eval()'d.
   ========================================================================== */
const NUM_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const isArr = v => Array.isArray(v);
const asNum = x => {
  const n = typeof x === 'number' ? x : parseFloat(String(x).trim());
  if (!Number.isFinite(n)) throw new Error(`'${x}' is not a number`);
  return n;
};
const elemAt = (v, k) => (isArr(v) ? v[Math.min(k, v.length - 1)] : v);
const each1 = (v, f) => (isArr(v) ? v.map(f) : f(v));
const each2 = (a, b, f) => {
  if (!isArr(a) && !isArr(b)) return f(a, b);
  const n = Math.max(isArr(a) ? a.length : 1, isArr(b) ? b.length : 1);
  const out = [];
  for (let k = 0; k < n; k++) out.push(f(elemAt(a, k), elemAt(b, k)));
  return out;
};

/* number -> text the way HDevelop writes it into a string (shortest of six
   significant digits, integers without a decimal point) */
function hdevNum(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(6)));
}
/* value -> the text a HALCON string concatenation appends (a tuple is joined
   with newlines, which is what fwrite_string writes into a file) */
const hdevText = v => (isArr(v)
  ? v.map(hdevText).join('\n')
  : (typeof v === 'number' ? hdevNum(v) : String(v === undefined || v === null ? '' : v)));
/* truth of a condition: like HDevelop, only a non-zero number is true */
const truthy = v => (isArr(v) ? truthy(v[0]) : typeof v === 'number' ? v !== 0 : asNum(v) !== 0);

/* HALCON text of a control value — the form the variable list shows */
function ctrlElemText(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
  const s = String(v === undefined || v === null ? '' : v);
  return (/[,\[\]']/.test(s) || s !== s.trim() || NUM_RE.test(s)) ? `'${s.replace(/'/g, "''")}'` : s;
}
const ctrlText = v => (isArr(v) ? `[${v.map(ctrlElemText).join(', ')}]` : ctrlElemText(v));
const ctrlType = v => (isArr(v)
  ? `${typeof v[0] === 'number' ? 'number' : 'string'} tuple (${v.length})`
  : (typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'real') : 'string'));

/* splits a tuple literal on its top-level commas, ignoring brackets and quotes */
function splitTopCommas(s) {
  const out = [];
  let cur = '', q = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === "'") { if (s[i + 1] === "'") { cur += "''"; i++; } else q = false; }
      cur += ch;
      continue;
    }
    if (ch === "'") { q = true; cur += ch; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/* one element of a stored tuple -> number or string */
function ctrlElemValue(s) {
  const t = String(s).trim();
  const q = /^'(.*)'$/s.exec(t);
  if (q) return q[1].replace(/''/g, "'");
  if (NUM_RE.test(t)) return +t;
  return t;
}

/* current value of a control variable as a JS value (number, string, array) */
function ctrlJsValue(name) {
  const rec = state.ctrl.get(name);
  if (!rec) return undefined;
  const v = rec.value;
  if (typeof v === 'number') return v;
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (/^\[[\s\S]*\]$/.test(s)) {
    const body = s.slice(1, -1).trim();
    return body ? splitTopCommas(body).map(ctrlElemValue) : [];
  }
  return ctrlElemValue(s);
}

/* the intrinsic functions available in a HALCON expression */
const CTRL_FUNCS = {
  abs:   a => each1(a[0], Math.abs),
  rad:   a => each1(a[0], x => asNum(x) * Math.PI / 180),
  deg:   a => each1(a[0], x => asNum(x) * 180 / Math.PI),
  sin:   a => each1(a[0], x => Math.sin(asNum(x))),
  cos:   a => each1(a[0], x => Math.cos(asNum(x))),
  tan:   a => each1(a[0], x => Math.tan(asNum(x))),
  asin:  a => each1(a[0], x => Math.asin(asNum(x))),
  acos:  a => each1(a[0], x => Math.acos(asNum(x))),
  atan:  a => each1(a[0], x => Math.atan(asNum(x))),
  atan2: a => Math.atan2(asNum(a[0]), asNum(a[1])),
  sqrt:  a => each1(a[0], x => Math.sqrt(asNum(x))),
  exp:   a => each1(a[0], x => Math.exp(asNum(x))),
  log:   a => each1(a[0], x => Math.log(asNum(x))),
  pow:   a => Math.pow(asNum(a[0]), asNum(a[1])),
  round: a => each1(a[0], x => Math.round(asNum(x))),
  int:   a => each1(a[0], x => Math.trunc(asNum(x))),
  floor: a => each1(a[0], x => Math.floor(asNum(x))),
  ceil:  a => each1(a[0], x => Math.ceil(asNum(x))),
  real:  a => each1(a[0], asNum),
  min:   a => (isArr(a[0]) ? Math.min(...a[0]) : Math.min(...a.map(asNum))),
  max:   a => (isArr(a[0]) ? Math.max(...a[0]) : Math.max(...a.map(asNum))),
  sum:   a => (isArr(a[0]) ? a[0].reduce((s, x) => s + asNum(x), 0) : asNum(a[0])),
  strlen: a => hdevText(a[0]).length,
  string: a => hdevText(a[0]),
  number: a => asNum(a[0]),
};

/* Evaluation of a HALCON control expression.  Throws with a readable message
   on anything it cannot evaluate. */
function parseCtrlExpr(src) {
  const s = String(src);
  const whole = s.trim();
  let i = 0;
  const fail = msg => { throw new Error(`${msg} in "${whole}"`); };
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };

  function readString() {                             // the quote is at s[i]
    i++;
    let out = '';
    while (i < s.length) {
      const ch = s[i];
      if (ch === "'") {
        if (s[i + 1] === "'") { out += "'"; i += 2; continue; }
        i++;
        return out;
      }
      if (ch === '\\') {
        const n = s[i + 1];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === undefined ? '\\' : n;
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
    fail('unterminated string');
  }

  function primary() {
    ws();
    const ch = s[i];
    if (ch === '(') {
      i++;
      const v = expr();
      ws();
      if (s[i] !== ')') fail("missing ')'");
      i++;
      return v;
    }
    if (ch === '[') {                                 // tuple […], concatenating nested tuples
      i++;
      const parts = [];
      ws();
      if (s[i] !== ']') for (;;) {
        const v = expr();
        if (isArr(v)) parts.push(...v); else parts.push(v);
        ws();
        if (s[i] === ',') { i++; continue; }
        break;
      }
      ws();
      if (s[i] !== ']') fail("missing ']'");
      i++;
      return parts;
    }
    if (ch === '|') {                                 // |Tuple| = number of elements
      i++;
      const v = expr();
      ws();
      if (s[i] !== '|') fail("missing '|'");
      i++;
      return isArr(v) ? v.length : 1;
    }
    if (ch === "'") return readString();
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (num) { i += num[0].length; return parseFloat(num[0]); }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (!id) fail('unexpected input');
    i += id[0].length;
    const name = id[0];
    ws();
    if (s[i] === '(') {                               // intrinsic: rad(180), max(a, b) …
      i++;
      const argv = [];
      ws();
      if (s[i] !== ')') for (;;) {
        argv.push(expr());
        ws();
        if (s[i] === ',') { i++; continue; }
        break;
      }
      ws();
      if (s[i] !== ')') fail("missing ')'");
      i++;
      const f = CTRL_FUNCS[name.toLowerCase()];
      if (!f) throw new Error(`unknown function '${name}' in "${whole}"`);
      return f(argv);
    }
    let v = ctrlJsValue(name);
    if (v === undefined) {
      const k = { pi: Math.PI, m_pi: Math.PI, e: Math.E }[name.toLowerCase()];
      if (k === undefined) throw new Error(`unknown control variable '${name}' in "${whole}"`);
      v = k;
    }
    for (;;) {                                        // Tuple[i] / 'string'[i]
      ws();
      if (s[i] !== '[') break;
      i++;
      const k = expr();
      ws();
      if (s[i] !== ']') fail("missing ']'");
      i++;
      const idx = Math.round(asNum(k));
      const len = isArr(v) ? v.length : hdevText(v).length;
      if (!(idx >= 0 && idx < len)) {
        throw new Error(`index ${idx} is outside '${name}' (${len} element(s)) in "${whole}"`);
      }
      v = isArr(v) ? v[idx] : hdevText(v)[idx];
    }
    return v;
  }

  function unary() {
    ws();
    if (s[i] === '-') { i++; return each1(unary(), x => -asNum(x)); }
    if (s[i] === '+') { i++; return each1(unary(), asNum); }
    const not = /^not\b/i.exec(s.slice(i));
    if (not) { i += not[0].length; return each1(unary(), x => (truthy(x) ? 0 : 1)); }
    return primary();
  }

  function mul() {
    let v = unary();
    for (;;) {
      ws();
      const op = s[i];
      if (op !== '*' && op !== '/' && op !== '%') return v;
      i++;
      const b = unary();
      v = each2(v, b, (x, y) => {
        const a = asNum(x), c = asNum(y);
        if (op === '*') return a * c;
        if (op === '/') { if (c === 0) throw new Error(`division by zero in "${whole}"`); return a / c; }
        if (c === 0) throw new Error(`modulo zero in "${whole}"`);
        return a % c;
      });
    }
  }

  function add() {
    let v = mul();
    for (;;) {
      ws();
      if (s[i] !== '+' && s[i] !== '-') return v;
      const op = s[i];
      i++;
      const b = mul();
      v = op === '+' ? concat(v, b) : each2(v, b, (x, y) => asNum(x) - asNum(y));
    }
  }

  /* '+' adds numbers and concatenates as soon as one side is a string */
  function concat(a, b) {
    if (isArr(a) || isArr(b)) return each2(a, b, concat);
    if (typeof a === 'string' || typeof b === 'string') return hdevText(a) + hdevText(b);
    return a + b;
  }

  function compare(a, b, kind) {
    return each2(a, b, (x, y) => {
      const bothNum = typeof x === 'number' && typeof y === 'number';
      const xs = bothNum ? x : hdevText(x), ys = bothNum ? y : hdevText(y);
      switch (kind) {
        case '=':  return xs === ys ? 1 : 0;
        case '#':  return xs !== ys ? 1 : 0;
        case '<':  return xs < ys ? 1 : 0;
        case '>':  return xs > ys ? 1 : 0;
        case '<=': return xs <= ys ? 1 : 0;
        default:   return xs >= ys ? 1 : 0;
      }
    });
  }

  function cmp() {
    let v = add();
    for (;;) {
      ws();
      let kind = null, len = 0;
      for (const [txt, k] of [['<=', '<='], ['>=', '>='], ['==', '='], ['#', '#'], ['!=', '#'], ['=', '='], ['<', '<'], ['>', '>']]) {
        if (s.startsWith(txt, i)) { kind = k; len = txt.length; break; }
      }
      if (!kind) return v;
      i += len;
      const b = add();
      const prev = v;
      v = compare(prev, b, kind);
    }
  }

  function andExpr() {
    let v = cmp();
    for (;;) {
      ws();
      if (s.startsWith('&&', i)) { i += 2; }
      else if (/^and\b/i.exec(s.slice(i))) { i += 3; }
      else return v;
      v = each2(v, cmp(), (x, y) => (truthy(x) && truthy(y)) ? 1 : 0);
    }
  }

  function expr() {
    let v = andExpr();
    for (;;) {
      ws();
      if (s.startsWith('||', i)) { i += 2; }
      else if (/^or\b/i.exec(s.slice(i))) { i += 2; }
      else return v;
      v = each2(v, andExpr(), (x, y) => (truthy(x) || truthy(y)) ? 1 : 0);
    }
  }

  if (!whole) fail('empty expression');
  const v = expr();
  ws();
  if (i < s.length) fail('unexpected input');
  return v;
}

/* `Name := expression` — HALCON's assignment statement.  A '\' left over from a
   joined continuation line (pixpum := \ [ … ]) is not part of the expression. */
function parseAssignment(text) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([\s\S]+)$/.exec(String(text === null || text === undefined ? '' : text));
  return m ? { name: m[1], expr: m[2].trim().replace(/^\\\s*/, '') } : null;
}

/* first word of a statement, lower case ('endfor', 'elseif', 'read_image').
   A line that assigns to a variable named like a keyword — 'Repeat := 0' or
   'for := 1' — has no statement word, it is an assignment. */
const lineWord = t => {
  const s = String(t).trim();
  if (parseAssignment(s)) return '';
  return (s.split(/[\s(]/, 1)[0] || '').toLowerCase();
};

/* Statement blocks of the structured statements.  A block is opened by one of
   the OPEN_WORDS and closed by its END_WORDS counterpart; the branch words of
   an if are found on the way through. */
const OPEN_WORDS = { if: 'endif', for: 'endfor', while: 'endwhile', repeat: 'until', switch: 'endswitch', try: 'endtry' };
const BRANCH_WORDS = new Set(['elseif', 'else']);
const isOpenWord = w => Object.prototype.hasOwnProperty.call(OPEN_WORDS, w);

/* 1-based line of the statement that closes the block opened at line `from`,
   skipping nested blocks; `branches` stops the search at the first
   else/elseif of this block instead.  null when the block is not closed. */
function findBlockEdge(proc, from, branches) {
  const L = linesOf(proc);
  let depth = 0;
  for (let n = from + 1; n <= L.length; n++) {
    const t = L[n - 1];
    if (!t || isComment(t)) continue;
    const w = lineWord(t);
    if (isOpenWord(w)) { depth++; continue; }
    if (depth > 0) {
      if (Object.values(OPEN_WORDS).includes(w)) depth--;
      continue;
    }
    if (Object.values(OPEN_WORDS).includes(w)) return n;
    if (branches && BRANCH_WORDS.has(w)) return n;
  }
  return null;
}

/* Why the processor cannot run a line: null = the line is fine (a comment, a
   blank line, a control-flow keyword such as `endif` — including the classic
   HDevelop spellings like `for Index := 0 to 5` that carry no parentheses — or
   a well-formed operator call). Anything else is an invalid line: a stray word,
   an operator call with a missing parenthesis, a trailing comment after `)` …
   Such a line counts as executable on purpose, so nextExecutable() walks the
   program counter onto it and execute() stops there instead of stepping over
   it and running on with the wrong data. */
function lineProblem(text) {
  const t = String(text === null || text === undefined ? '' : text).trim();
  if (!t || isComment(t) || parseLine(t)) return null;
  if (parseAssignment(t)) return null;                     // UpdateX := expression
  const word = t.split(/[\s(]/, 1)[0];
  const hasParen = t.indexOf('(') >= 0;
  if (HD_KEYWORDS.has(word) && !hasParen) return null;      // bare keyword / alternate syntax
  if (isOpenWord(word) || /^(?:for|if)\b/i.test(word)) return null;
  const head = word.length > 24 ? `${word.slice(0, 24)}…` : word;
  return hasParen ? "no closing ')'"
                  : `'${head}' is not an operator call`;
}

const isExecutable = t => parseLine(t) !== null || parseAssignment(t) !== null ||
  CONTROL_WORDS.has(lineWord(t)) || lineProblem(t) !== null;

/* Character ranges of the arguments of a call line, in the same order
   parseLine() produces them — used to rewrite a single argument in place
   (the Operator Window writes a picked image file into FileName). */
function argSpans(text) {
  const open = text.indexOf('('), close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const body = text.slice(open + 1, close);
  const spans = [];
  const push = (s, e) => {
    while (s < e && /\s/.test(body[s])) s++;
    while (e > s && /\s/.test(body[e - 1])) e--;
    spans.push({ start: open + 1 + s, end: open + 1 + e });
  };
  let start = 0, q = false, depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'") q = !q;
    else if (!q && ch === '[') depth++;
    else if (!q && ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && !q && depth === 0) { push(start, i); start = i + 1; }
  }
  if (body.trim() !== '' || spans.length) push(start, body.length);
  return spans;
}

function nextExecutable(proc, from) {   // from is 1-based, search strictly after
  const L = linesOf(proc);
  for (let i = from + 1; i <= L.length; i++) if (isExecutable(L[i - 1])) return i;
  return null;
}
function firstExecutable(proc) { return nextExecutable(proc, 0); }

/* ==========================================================================
   SYNTHETIC CAMERA IMAGE (source for read_image)
   ========================================================================== */
const IMG_W = 640, IMG_H = 480;
let syntheticCanvas = null;             // generated chip image, fed to cv.imread

function buildChipImage() {
  const c = document.createElement('canvas');
  c.width = IMG_W; c.height = IMG_H;
  const x = c.getContext('2d');

  const g = x.createLinearGradient(0, 0, IMG_W, IMG_H);
  g.addColorStop(0, '#2a3540'); g.addColorStop(.5, '#1e262e'); g.addColorStop(1, '#242e37');
  x.fillStyle = g; x.fillRect(0, 0, IMG_W, IMG_H);

  // faint PCB trace grid
  x.strokeStyle = 'rgba(150,170,190,0.07)'; x.lineWidth = 1;
  for (let i = 0; i < 26; i++) {
    x.beginPath(); x.moveTo(0, i * 19 + (i % 3)); x.lineTo(IMG_W, i * 19); x.stroke();
  }
  for (let i = 0; i < 34; i++) {
    x.beginPath(); x.moveTo(i * 19, 0); x.lineTo(i * 19 + (i % 4), IMG_H); x.stroke();
  }

  // copper pads (ring of bright squares around the die)
  const cx = IMG_W / 2, cy = IMG_H / 2;
  x.fillStyle = '#b9c4cd';
  for (let i = 0; i < 22; i++) {
    const px = 90 + i * 22;
    x.fillRect(px, 96, 14, 14); x.fillRect(px, 370, 14, 14);   // top / bottom rows
  }
  for (let i = 0; i < 12; i++) {
    const py = 130 + i * 22;
    x.fillRect(96, py, 14, 14); x.fillRect(530, py, 14, 14);   // left / right cols
  }

  // bond wires (kept below the segmentation threshold so parts stay separate)
  x.strokeStyle = 'rgba(190,200,210,0.35)'; x.lineWidth = 1.5;
  for (let i = 0; i < 22; i += 2) {
    const px = 90 + i * 22 + 7;
    x.beginPath(); x.moveTo(px, 110); x.lineTo(cx + (i - 11) * 9, cy - 62); x.stroke();
    x.beginPath(); x.moveTo(px, 377); x.lineTo(cx + (i - 11) * 9, cy + 62); x.stroke();
  }

  // chip die: bright rectangle with gradient
  const dg = x.createLinearGradient(cx - 130, cy - 90, cx + 130, cy + 90);
  dg.addColorStop(0, '#d7dee4'); dg.addColorStop(.55, '#aeb9c2'); dg.addColorStop(1, '#7f8b95');
  x.fillStyle = dg;
  x.fillRect(cx - 130, cy - 90, 260, 180);

  // die inner structure (dark sub-rectangles)
  x.fillStyle = '#5d6873';
  x.fillRect(cx - 100, cy - 60, 90, 54); x.fillRect(cx + 10, cy - 60, 90, 54);
  x.fillRect(cx - 100, cy + 8, 90, 54);  x.fillRect(cx + 10, cy + 8, 90, 54);
  x.fillStyle = '#454f59';
  x.fillRect(cx - 96, cy - 56, 40, 20); x.fillRect(cx + 30, cy - 56, 40, 20);
  x.fillRect(cx - 96, cy + 12, 40, 20); x.fillRect(cx + 30, cy + 12, 40, 20);

  // orientation dot + two bright reference blobs (guarantee stable regions)
  x.fillStyle = '#e8edf1';
  x.beginPath(); x.arc(cx - 118, cy - 78, 6, 0, 7); x.fill();
  x.fillStyle = '#cdd6dd';
  x.beginPath(); x.arc(120, 92, 26, 0, 7); x.fill();
  x.beginPath(); x.arc(548, 402, 20, 0, 7); x.fill();
  x.fillStyle = '#dde5ea';
  x.beginPath(); x.arc(520, 84, 14, 0, 7); x.fill();

  // sensor noise
  const id = x.getImageData(0, 0, IMG_W, IMG_H);
  const d = id.data;
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - .5) * 14;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  x.putImageData(id, 0, 0);
  return c;
}

/* ==========================================================================
   RENDERING
   ========================================================================== */
const now = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

function log(text, kind) {
  const t = performance.now();          // the entry is bookkeeping, not execution
  state.history.push({ t: now(), kind: kind || 'msg', text });
  renderHistory();
  logCost += performance.now() - t;
}

/* ---------------- history window ---------------- */
function renderHistory() {
  const body = $('#history-body');
  if (state.histTab === 'errors') {
    body.innerHTML = state.errors.length
      ? state.errors.map(e => `<div class="hist-row err"><span class="t">${e.t}</span>${esc(e.text)}</div>`).join('')
      : '<div class="empty-note">No error messages.</div>';
  } else {
    body.innerHTML = state.history.length
      ? state.history.map(h => `<div class="hist-row ${h.kind}"><span class="t">${h.t}</span>${esc(h.text)}</div>`).join('')
      : '<div class="empty-note">No commands executed yet. Press F5 to run the program.</div>';
  }
  body.scrollTop = body.scrollHeight;
}

/* ---------------- program window ---------------- */
function renderProgram() {
  if (monacoEditor) monacoRefreshDecorations();   // Monaco holds the text; refresh decorations only
}

/* ---------------- operator window ---------------- */
function renderOperator() {
  const body = $('#operator-body');
  closeValueMenu();                 // the panel is redrawn: the list belongs to it
  const text = lineText(state.proc, state.cursor) || '';
  const parsed = parseLine(text);

  if (state.opTab === 'iconic') return renderOpVarList(body, 'iconic');
  if (state.opTab === 'control') return renderOpVarList(body, 'control');

  if (!parsed || !OPINFO[parsed.op]) {
    body.innerHTML = `<div class="op-info">No operator selected.<br>` +
      `Click a program line to inspect its operator.</div>`;
    return;
  }
  const info = OPINFO[parsed.op];
  const isDev = isDisplayOp(parsed.op);
  const sig = `${parsed.op} ( ${info.params.map(p => p[0]).join(', ')} )`;

  let html = `<div class="op-head"><span class="op-name ${isDev ? 'dev' : ''}">${parsed.op}</span>` +
             `<span class="op-sig">${esc(sig)}</span></div>`;

  if (state.opTab === 'info') {
    body.innerHTML = html + `<div class="op-info">${info.desc}<br><br>` +
      `<span class="dim">Signature:</span> <code>${esc(sig)}</code></div>`;
    return;
  }

  const args = parsed.args;
  const rows = dir => info.params
    .map((p, i) => ({ p, v: args[i], i }))
    .filter(r => r.p[1] === dir);
  const section = (title, dir) => {
    const rs = rows(dir);
    if (!rs.length) return '';
    return `<div class="op-section"><h4>${title}</h4>` + rs.map(r => {
      const isIconic = r.p[2] === 'iconic';
      const def = r.p.length > 3 ? String(r.p[3]) : '';
      const missing = r.v === undefined || r.v === '';
      const val = missing ? '' : r.v;
      /* what the field starts with: the argument, or the operator default of an
         argument the line does not pass (that field is marked with .def) */
      const shown = missing && def ? def : val;
      const values = isIconic ? null : paramValues(parsed.op, r.p[0]);
      const field = paramField(r.i, r.p[0], isIconic, shown, values, missing && def ? def : '');
      const valHtml = isIconic
        ? `<span class="pval iconic${missing && def ? ' def' : ''}">${iconicThumb(val)}${field}</span>`
        : field;
      return `<div class="op-row"><span class="dir ${dir === 'input' ? 'in' : 'out'}">${dir === 'input' ? '&#9654;' : '&#9664;'}</span>` +
             `<span class="pname">${r.p[0]}</span>${valHtml}` +
             `<span class="pkind">${r.p[2]}</span></div>`;
    }).join('') + '</div>';
  };
  body.innerHTML = html + imageSourceBar(parsed) +
    section('Input parameters', 'input') + section('Output parameters', 'output');
}

/* The value of one parameter as a field.  Every parameter is typed into — a
   control input and output, an iconic variable name (typing another name renames
   it in the line).  A parameter with a fixed set of values (PARAM_VALUES) gets an
   arrow that opens the whole list (see toggleValueMenu), so select_shape's
   Features can be picked instead of remembered.  An argument the line does not
   pass starts with the operator default, marked with .def. */
function paramField(i, name, isIconic, shown, values, def) {
  const text = String(shown == null ? '' : shown).trim();
  const title = isIconic
    ? 'variable name — typing another name renames it in the program line'
    : values
    ? (def ? 'the operator default — the line passes no argument here; type or pick a value to write one'
           : 'type a value, or pick one from the list — it is written into the program line')
    : 'type a value, a variable or an expression — it is written into the program line';
  /* the field sits *inside* the value box when the box has to hold something
     else too (the region thumbnail of an iconic value, the arrow of a list) and
     *is* the box otherwise — see the .pval rules in css/style.css */
  const cls = isIconic || values ? 'pval-in' : `pval pval-in${def ? ' def' : ''}`;
  const input = `<input class="${cls}" data-arg="${i}" data-pname="${attr(name)}"` +
    ` value="${attr(text)}"` + (text || !def ? '' : ` placeholder="${attr(def)}"`) +
    ` spellcheck="false" title="${attr(title)}">`;
  if (!values) return input;
  return `<span class="pval pval-box${def ? ' def' : ''}">${input}` +
    `<span class="pval-arrow" data-pick="${i}" title="every ${attr(name)} the operator accepts">&#9662;</span></span>`;
}

/* The whole value list a field's arrow opens.  This cannot be a native
   <datalist>: the browser filters its options by the text in the field, so a
   field holding 'area' offered 'area' alone instead of select_shape's ten
   features — the list looked incomplete.  The menu is a <div> in <body> (the
   Operator Window scrolls, and a list inside it would be clipped) positioned
   under the field. */
let pvalMenu = null;      // the <div> the list is drawn into (made on first use)
let pvalMenuFor = -1;     // the data-arg of the field that opened it

function valueMenuEl() {
  if (pvalMenu) return pvalMenu;
  pvalMenu = document.createElement('div');
  pvalMenu.className = 'pval-menu';
  pvalMenu.hidden = true;
  /* mousedown, not click: the field must not commit its (unfinished) text while
     the pick is on its way */
  pvalMenu.addEventListener('mousedown', e => {
    const item = e.target.closest('.pval-item');
    if (!item) return;
    e.preventDefault();
    const i = +item.dataset.pick;
    const field = $(`#operator-body input[data-arg="${i}"]`);
    closeValueMenu();
    if (!field) return;
    field.value = item.dataset.val;
    setLineArg(i, item.dataset.val, field.dataset.pname);
  });
  document.body.appendChild(pvalMenu);
  /* a click anywhere else closes it — the arrow itself toggles it, so it is left
     to the click handler of the Operator Window */
  document.addEventListener('mousedown', e => {
    if (!pvalMenu.hidden && !e.target.closest('.pval-menu') && !e.target.closest('[data-pick]')) {
      closeValueMenu();
    }
  });
  return pvalMenu;
}

function closeValueMenu() {
  if (pvalMenu && !pvalMenu.hidden) { pvalMenu.hidden = true; pvalMenu.innerHTML = ''; }
  pvalMenuFor = -1;
}

/* open the value list of the field i — or close it again when it is already that
   field's, which is what its arrow should do */
function toggleValueMenu(i) {
  const field = $(`#operator-body input[data-arg="${i}"]`);
  if (!field) return;
  if (pvalMenu && !pvalMenu.hidden && pvalMenuFor === i) { closeValueMenu(); return; }
  const parsed = parseLine(lineText(state.proc, state.cursor) || '');
  if (!parsed || !OPINFO[parsed.op]) return;
  const values = paramValues(parsed.op, field.dataset.pname);
  if (!values || !values.length) return;
  const cur = String(field.value).trim().toLowerCase();
  const m = valueMenuEl();
  m.innerHTML = values.map(v => {
    const lit = valueLiteral(v);
    return `<div class="pval-item${String(lit).toLowerCase() === cur ? ' cur' : ''}"` +
           ` data-pick="${i}" data-val="${attr(lit)}">${esc(lit)}</div>`;
  }).join('');
  m.hidden = false;
  pvalMenuFor = i;
  const box = field.closest('.pval') || field;
  const r = box.getBoundingClientRect();
  m.style.minWidth = `${Math.round(r.width)}px`;
  const mr = m.getBoundingClientRect();
  m.style.left = `${Math.round(Math.max(4, Math.min(r.left, window.innerWidth - mr.width - 4)))}px`;
  const below = r.bottom + 2;
  m.style.top = `${Math.round(below + mr.height > window.innerHeight - 4
    ? Math.max(4, r.top - mr.height - 2) : below)}px`;
}

/* what the text typed into a parameter field means.  One of the operator's values
   (PARAM_VALUES) becomes that value, so a keyword need not be quoted ('margin');
   everything that already is an expression — a number, a tuple, a quoted string,
   a variable, a call — is written as it is; a bare word with punctuation (a file
   name, a path) becomes a string. */
function typedLiteral(op, name, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const values = paramValues(op, name);
  if (values) {
    const hit = values.find(v => String(v).toLowerCase() === s.toLowerCase());
    if (hit !== undefined) return valueLiteral(hit);
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s;      // a variable
  if (/^[-+.\d]/.test(s) || /^['"[]/.test(s)) return s;   // a number, a tuple, a literal
  return `'${s.replace(/'/g, "''")}'`;                   // a file name / a path
}

function iconicThumb(name) {
  const rec = state.iconic.get(name);
  if (!rec) return '<canvas width="34" height="24"></canvas>';
  return `<canvas width="34" height="24" data-thumb="${esc(name)}"></canvas>`;
}

function renderOpVarList(body, kind) {
  if (kind === 'iconic') {
    body.innerHTML = state.iconic.size
      ? `<div class="op-section"><h4>Iconic variables</h4>` +
        [...state.iconic.keys()].map(k =>
          `<div class="op-row"><span class="pval iconic">${iconicThumb(k)}<span>${k}</span></span></div>`).join('') + '</div>'
      : '<div class="empty-note">No iconic variables defined.</div>';
  } else {
    body.innerHTML = state.ctrl.size
      ? `<div class="op-section"><h4>Control variables</h4>` +
        [...state.ctrl.entries()].map(([k, v]) =>
          `<div class="op-row"><span class="pname">${k}</span><span class="pval">${esc(String(v.value))}</span><span class="pkind">${v.type}</span></div>`).join('') + '</div>'
      : '<div class="empty-note">No control variables defined.</div>';
  }
}

/* paint small thumbnails after DOM update */
function paintThumbs(root) {
  $$('canvas[data-thumb]', root).forEach(cv => {
    const rec = state.iconic.get(cv.dataset.thumb);
    const x = cv.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, cv.width, cv.height);
    if (!rec) return;
    paintIconic(rec, x, cv.width, cv.height);
  });
}

/* ---------------- read_image: picking the image file ---------------- */
/* The Parameter that names an image file (read_image's FileName). Operators
   without such a parameter get no file controls in the Operator Window. */
const IMAGE_FILE_PARAM = 'FileName';
const IMAGE_DIR_PARAM = 'ImageDirectory';
function imageFileParamIndex(op) {
  const info = OPINFO[op];
  return info ? info.params.findIndex(p => p[0] === IMAGE_FILE_PARAM) : -1;
}
function imageDirParamIndex(op) {
  const info = OPINFO[op];
  return info ? info.params.findIndex(p => p[0] === IMAGE_DIR_PARAM) : -1;
}

/* bar above the parameter list of an operator that reads image files or an image
   folder: which folder this program uses, the buttons that set it, and — for an
   operator with a file parameter — the image files available in this session */
function imageSourceBar(parsed) {
  const fidx = imageFileParamIndex(parsed.op);
  const didx = imageDirParamIndex(parsed.op);
  if (fidx < 0 && didx < 0) return '';
  let html = '';
  if (fidx >= 0) {
    const cur = imageArgName(parsed.args[fidx]);
    const known = IMAGE_SOURCES.get(cur);
    const opts = [];
    if (cur && !known) opts.push(`<option value="${esc(cur)}" selected>${esc(cur)} — not loaded</option>`);
    for (const rec of IMAGE_SOURCES.values()) {
      opts.push(`<option value="${esc(rec.name)}"${rec.name === cur ? ' selected' : ''}>` +
        `${esc(rec.name)}${rec.builtin ? ' (demo)' : ` (${rec.w}×${rec.h})`}</option>`);
    }
    html += `<span class="fb-label">Image file</span>` +
      `<select id="op-imgsrc" title="Image file that the ${esc(IMAGE_FILE_PARAM)} parameter refers to">` +
      `${opts.join('')}</select>`;
  }
  const dirShown = IMAGE_DIR ? IMAGE_DIR : (pageFolderListable
    ? '(page folder — listed by the server)'
    : '(page folder — not listable; use Server… or Folder…)');
  html += `<span class="fb-label" title="Folder that list_image_files ('./') and read_image use">Folder</span>` +
    `<span class="fb-label" data-dirshown>${esc(dirShown)}</span>` +
    `<button class="op-btn" data-loadimg title="Read image files from disk (PNG, JPG, BMP, GIF, TIFF, WebP) — pick several at once. The folder of the picked files becomes the folder list_image_files ('./') reads">` +
    `Load file…</button>` +
    `<button class="op-btn" data-loadfolder title="Read every image of a folder (PNG, JPG, BMP, GIF, TIFF, WebP) — the folder becomes the folder that list_image_files ('./') reads">` +
    `Load folder…</button>` +
    `<button class="op-btn" data-setdir title="Grant the folder that holds the program's images: list_image_files ('./') lists it and read_image reads any single image of it">` +
    `Folder…</button>` +
    `<button class="op-btn" data-browse title="Browse a folder of the server (the project's dev server lists every folder, a granted folder needs no permission): open a program, or take a folder as the one list_image_files ('./') reads">` +
    `Server…</button>`;
  return `<div class="op-filebar">${html}</div>`;
}

/* file picker -> read_image.  Several files can be picked at once (Ctrl/Shift
   click), which loads a set of images: every file becomes an image source, sorted
   by name, so a program's `list_image_files` and `read_image (Image, ImageFiles[3])`
   find them like in HDevelop. */
function openImageFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = IMAGE_FILE_ACCEPT;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.remove();
    await loadImageFiles(files, 'Load file');
  });
  input.click();
}

/* folder picker -> the whole folder.  A page cannot list a directory itself, but
   `<input webkitdirectory>` asks the browser to hand over every file inside the
   picked folder; the images among them are decoded here and registered under
   their names, which is exactly what `list_image_files` then reports.  This is
   what makes a program that does `list_image_files ('./', ...)` followed by
   `read_image (Image, ImageFiles[3])` run against the real folder. */
function openImageFolder() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.webkitdirectory = true;
  input.accept = IMAGE_FILE_ACCEPT;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.remove();
    if (!files.length) return;
    const images = files.filter(f => isImageFileName(f.name)).sort((a, b) => imageNameSort(a.name, b.name));
    const skipped = files.length - images.length;
    /* remember the folder, it becomes the folder relative file names of the
       program resolve against (see imageDirUrl) */
    const rel = (images[0] && images[0].webkitRelativePath) || '';
    if (rel.includes('/')) IMAGE_DIR = rel.replace(/\/[^/]*$/, '/');
    if (IMAGE_DIR) rememberProgDir(state.progFile, IMAGE_DIR);
    if (!images.length) {
      log(`Load folder: no image file in the picked folder (${files.length} file(s) there, ` +
        `none with an image extension).`, 'warn');
      return;
    }
    log(`Load folder: ${images.length} image file(s) found` +
      (skipped ? `, ${skipped} non-image file(s) skipped` : '') + '.', 'msg');
    if (IMAGE_DIR) log(`Load folder: '${IMAGE_DIR}' is now the folder of list_image_files ('./').`, 'msg');
    await loadImageFiles(images, 'Load folder');
  });
  input.click();
}

/* decode a picked set of files and keep every one that decodes as an image
   source under its own name; the first one is shown in the editor's read_image
   line so it turns up in the graphics window.  Returns the registered names. */
async function loadImageFiles(files, what) {
  if (!files || !files.length) return [];
  const loaded = [], failed = [];
  for (const f of files) {
    try { loaded.push(await readImageFile(f)); }
    catch (e) { failed.push(f.name); }
  }
  for (const n of failed) log(`${what}: '${n}' could not be decoded as an image.`, 'err');
  if (loaded.length > 1) {
    log(`${what}: ${loaded.length} image file(s) loaded — list_image_files now offers ` +
      `${loaded.length} name(s), in sorted order.`, 'msg');
  }
  if (loaded.length) setImageSource(loaded[0]);
  return loaded;
}

/* decode a picked file and keep it as an image source under its own name;
   resolves with the registered name */
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      /* the picture is kept as an image source; the gray frame the operators
         work on is built on the first read of it and then reused */
      const rec = registerDecodedSource(file.name, img);
      const { srcW: w, srcH: h, scaled } = rec;
      log(`Loaded image file '${file.name}' (${rec.canvas.width}×${rec.canvas.height}` +
        (scaled ? `, reduced from ${w}×${h}` : '') + ').', 'msg');
      if (scaled) {
        log(`Loaded image file '${file.name}': ${w}×${h} exceeds ${IMAGE_MAX_SIDE} px, so it was ` +
          `reduced to ${rec.canvas.width}×${rec.canvas.height} — distances measured on it are scaled by ` +
          `${(w / rec.canvas.width).toFixed(4)}.`, 'warn');
      }
      resolve(file.name);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`'${file.name}' cannot be decoded`));
    };
    img.src = url;
  });
}

/* Point FileName of the read_image line at the cursor at `name` and read the
   image at once, so an uploaded file shows up in the graphics window. */
function setImageSource(name) {
  const n = state.cursor;
  const text = lineText(state.proc, n) || '';
  const parsed = parseLine(text);
  const idx = parsed ? imageFileParamIndex(parsed.op) : -1;
  if (idx < 0) {
    log(`Image source: line ${n} is not a read_image — '${name}' is kept for the next ` +
        `read_image call (use list_image_files to get the loaded names).`, 'msg');
    renderOperator();
    return;
  }
  const spans = argSpans(text);
  const lit = `'${name}'`;
  if (spans && spans[idx] && text.slice(spans[idx].start, spans[idx].end) !== lit) {
    linesOf(state.proc)[n - 1] =
      text.slice(0, spans[idx].start) + lit + text.slice(spans[idx].end);
    $('#proc-modified').style.visibility = 'visible';
    editorLoad();
    edFocusLine(n);
    scheduleSave();
    log(`read_image: FileName on line ${n} set to ${lit}.`, 'msg');
  }
  readImageLine(n);
}

/* read the image of one program line without running the whole procedure */
async function readImageLine(n) {
  if (state.running) { renderOperator(); return; }
  try { await execute(state.proc, n); }
  catch (e) { log(`read_image: ${e.message}`, 'err'); }
  renderOperator();
  paintThumbs();
}

/* Write one parameter of the call on the selected program line — the fields of
   the Parameters tab (see paramField), typed into or picked from a list.  What
   was typed is turned into a HALCON expression first (see typedLiteral).  An
   argument the line does not pass is appended along with the arguments before it
   (their HALCON defaults), so the call stays well-formed, and the line is then
   executed like a stepped line, so the new value shows up in the graphics window
   at once.  `focusEditor` is true only for an explicit Enter: typing a value then
   ends in the Program Window, while picking a value from the list leaves the
   keyboard where it was, in the field, so the next value can be typed at once. */
async function setLineArg(i, typed, param, focusEditor = false) {
  const n = state.cursor;
  const text = lineText(state.proc, n) || '';
  const parsed = parseLine(text);
  if (!parsed || !OPINFO[parsed.op]) return;
  const literal = typedLiteral(parsed.op, param, typed);
  if (!literal) {                       // an emptied field: the line keeps its value
    log(`Line ${n}: the ${param} field was emptied — the program line keeps its value.`, 'warn');
    renderOperator();
    return;
  }
  const spans = argSpans(text);
  let next;
  if (spans && spans[i]) {
    next = text.slice(0, spans[i].start) + literal + text.slice(spans[i].end);
  } else {
    const open = text.indexOf('('), close = text.lastIndexOf(')');
    if (open < 0 || close < open) { renderOperator(); return; }
    const add = [];
    for (let k = spans ? spans.length : 0; k < i; k++) {
      const e = opInsertEntries(parsed.op)[k];
      add.push(e ? e.txt : '');           // the arguments in between, with their defaults
    }
    add.push(literal);
    const sep = text.slice(open + 1, close).trim() ? ', ' : '';   // dev_set_draw () -> ('margin')
    next = text.slice(0, close).replace(/[\s,]+$/, '') + sep + add.join(', ') + text.slice(close);
  }
  if (next === text) { renderOperator(); return; }   // the field shows the line again
  linesOf(state.proc)[n - 1] = next;
  $('#proc-modified').style.visibility = 'visible';
  editorLoad();
  edFocusLine(n, focusEditor);
  scheduleSave();
  log(`Line ${n}: ${parsed.op}'s ${param} set to ${literal}.`, 'msg');
  if (state.running) { renderOperator(); return; }
  /* The line is run so the new value shows up in the graphics window at once —
     but only when the variables it reads are defined: before the program has
     been started (or stepped to this line) its inputs do not exist, and running
     the line would only halt with 'not defined' and put the error box in the way
     of the next field.  The reason is logged instead.  The rewritten line is
     what is inspected, so renaming an argument to a variable that does not exist
     yet is caught as well. */
  const undef = undefinedInputs(parseLine(next));
  if (undef.length) {
    log(`Line ${n}: ${parsed.op} was not run — ${undef.map(v => `'${v}'`).join(', ')} ` +
      `${undef.length > 1 ? 'are' : 'is'} not defined yet (run F5, or step to the line first).`, 'msg');
    renderOperator();
    paintThumbs();
    return;
  }
  try { await execute(state.proc, n); }
  catch (e) { log(`${parsed.op}: ${e.message}`, 'err'); }
  renderOperator();
  paintThumbs();
}

/* The input variables of a parsed line that the program has not produced yet (a
   literal argument needs no variable), so the line cannot be run on its own. */
function undefinedInputs(parsed) {
  if (!parsed) return [];
  const info = OPINFO[parsed.op];
  if (!info) return [];
  const missing = [];
  parsed.args.forEach((a, i) => {
    const p = info.params[i];
    if (!p || p[1] !== 'input') return;
    const v = String(a == null ? '' : a).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return;
    if (p[2] === 'iconic' ? state.iconic.has(v) : state.ctrl.has(v)) return;
    if (!missing.includes(v)) missing.push(v);
  });
  return missing;
}

/* ---------------- the folder a program reads from ---------------- */
/* A page cannot see the path of a file picked with <input type=file>, so a
   program opened from disk cannot learn its own folder.  Granting the folder
   once covers it for the rest of the session, and the granted/loaded folder is
   remembered per program name so later runs need no extra click. */
const PROGDIR_KEY = 'opencvs.progdir.v1';

function progDirMap() {
  try { return JSON.parse(localStorage.getItem(PROGDIR_KEY)) || {}; }
  catch (e) { return {}; }
}
function rememberProgDir(prog, dir) {
  if (!prog || dir == null) return;                       // '' is a folder, too
  const map = progDirMap();
  map[prog.toLowerCase()] = dir;
  const keys = Object.keys(map);
  while (keys.length > 24) delete map[keys.shift()];      // keep it small
  try { localStorage.setItem(PROGDIR_KEY, JSON.stringify(map)); } catch (e) { /* full or blocked */ }
}
/* the remembered folder, or null when this program has none: '' is the page's
   own folder, which must not be confused with "nothing remembered" */
function recallProgDir(prog) {
  if (!prog) return null;
  const map = progDirMap();
  const key = prog.toLowerCase();
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

/* "Folder…": grant the folder that holds the program and its images, with the
   File System Access API.  Nothing is decoded here — list_image_files enumerates
   the granted folder and read_image decodes only the images the program asks
   for.  The browser cannot tell a page the folder of a program that was opened
   from disk, so granting the folder once is what makes
   `list_image_files ('./', 'default', [], ImageFiles)` list the real folder. */
async function setWorkingFolder() {
  if (typeof window.showDirectoryPicker !== 'function') {
    log('Folder: this browser cannot open a folder directly — use "Load folder…", ' +
      'which also sets the folder of list_image_files (\'./\').', 'warn');
    return;
  }
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: 'read', id: 'ovs-images' }); }
  catch (e) { return; }                                  // the user cancelled
  IMAGE_DIR_HANDLE = dir;
  IMAGE_DIR = dir.name + '/';
  IMAGE_URLS.clear();
  rememberProgDir(state.progFile, IMAGE_DIR);
  log(`Folder: '${IMAGE_DIR}' is now the folder that list_image_files ('./') lists and ` +
    `read_image reads from` + (state.progFile ? ` (remembered for '${state.progFile}').` : '.'), 'msg');
  renderOperator();
}

/* ---------------- Browse Server Folder: the folder browser ---------------- */
/* A program opened by path is fetched, so its own folder is known and becomes the
   folder of `list_image_files ('./')` with no folder grant at all.  The dialog
   walks the server's folder tree (see listFolderEntries): the project's own dev
   server lists every folder, a plain static server lists the ones that have no
   index.html in them. */
const PROGRAM_FILE_RE = /\.(odev|hdev|ovs)$/i;
const upDir = here => {
  const p = here.replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};
const joinPath = (dir, name) => (dir ? dir.replace(/\/+$/, '') + '/' : '') + name;

function openProgramFromServer() { return showServerBrowser(''); }

/* Is the page's own folder listable?  The project's dev server lists it (see
   listFolderEntries); a plain static server cannot, because it answers with
   index.html instead of an index.  Probed once, for the label of the folder bar */
let pageFolderListable = null;
async function probePageFolder() {
  if (!appBaseUrl()) { pageFolderListable = false; return; }
  const before = pageFolderListable;
  try { pageFolderListable = !!(await listFolderEntries('')); } catch (e) { pageFolderListable = false; }
  if (pageFolderListable !== before) renderOperator();
}

/* Folders of this server that listed successfully before, newest first.  The
   dialog offers them when the folder asked for cannot be listed, so a static
   server is not a dead end.  Kept per origin: the same folder may list on the
   dev server and not on a static one */
const SRCDIR_KEY = 'opencvs.srcdir.v1';
function recentDirs() {
  try { return JSON.parse(localStorage.getItem(SRCDIR_KEY + '@' + location.origin)) || []; }
  catch (e) { return []; }
}
function rememberDir(rel) {
  const v = String(rel == null ? '' : rel).replace(/\/+$/, '');
  const list = recentDirs().filter(d => d !== v);
  list.unshift(v);
  while (list.length > 12) list.pop();
  try { localStorage.setItem(SRCDIR_KEY + '@' + location.origin, JSON.stringify(list)); }
  catch (e) { /* full or blocked */ }
}

/* Does the server the page came from still answer at all?  Tells "this folder is
   not listable" apart from "the server is gone" */
async function serverReachable() {
  try {
    await fetch(new URL('index.html', appBaseUrl()).href, { method: 'HEAD', cache: 'no-store' });
    return true;
  } catch (e) { return false; }
}

/* the dialog itself: current folder, its folders/programs, and a path box */
async function showServerBrowser(here, note = '', isErr = false) {
  if (!/^https?:/.test(location.protocol)) {
    log('Browse Server Folder: the page has to be served over HTTP — a file:// page cannot ' +
      'fetch a program or list a folder. Serve it (py -m http.server 8123) and reload.', 'warn');
    return;
  }
  const entries = await listFolderEntries(here);
  if (entries) rememberDir(here);
  const listing = entries
    ? `${entries.files.length} file(s)` +
      (entries.via === 'api' ? ' — listed by the dev server' : ' — from the folder index')
    : '';
  let body = `<p class="dim" style="margin-top:0">Folder <code>/${esc(here)}</code>` +
    (listing ? ` &mdash; ${listing}` : '') + `</p>` +
    (note ? `<div class="${isErr ? 'errline' : 'dim'}">${note}</div>` : '');
  const row = (label, attrs, dim) =>
    `<div ${attrs} style="padding:3px 8px;cursor:pointer${dim ? ';color:var(--text-dim)' : ''}">` +
    `${esc(label)}</div>`;
  let rows = '', others = 0;
  if (entries) {
    const dirs = entries.dirs.slice().sort(imageNameSort);
    const progs = entries.files.filter(f => PROGRAM_FILE_RE.test(f)).sort(imageNameSort);
    others = entries.files.length - progs.length;
    if (here) rows += row('../', 'data-dir=".."', true);
    for (const d of dirs) rows += row(d, `data-dir="${esc(d)}"`);
    for (const f of progs) rows += row(f, `data-prog="${esc(f)}"`);
    if (!rows) rows = `<div class="empty-note">no folder and no program (*.odev, *.hdev, *.ovs) here</div>`;
  } else {
    /* not listable: say which of the two reasons it is, and offer a way on */
    body += await serverReachable()
      ? `<div class="errline">This server does not list <code>/${esc(here)}</code>: a plain ` +
        `static server answers a folder that holds <code>index.html</code> with the page itself, ` +
        `instead of an index. Serve the project with its own dev server ` +
        `(<code>node tools/serve.js</code>, port 8177) to browse the whole tree, or type a folder ` +
        `below, e.g. <code>example</code>, or a program, e.g. <code>example/MAIN.hdev</code>.</div>`
      : `<div class="errline">Nothing answers at <code>${esc(location.origin)}</code> any more — ` +
        `is the server still running? Start it again (<code>node tools/serve.js</code>, or ` +
        `<code>py -m http.server 8123</code>) and reopen this dialog.</div>`;
    const known = [];
    /* IMAGE_DIR keeps its trailing slash for building names; the browser works in
       slash-less relative folders, so normalise before comparing or they'd both show */
    for (const cand of [...recentDirs(), IMAGE_DIR, recallProgDir(state.progFile)]) {
      if (cand == null) continue;
      const d = String(cand).replace(/\/+$/, '');
      if (known.includes(d) || d === here.replace(/\/+$/, '')) continue;
      if (d === '' && pageFolderListable === false) continue;      // would not list here either
      known.push(d);
    }
    if (known.length) rows += `<div class="dim" style="padding:3px 8px">folders that listed:</div>`;
    for (const d of known) rows += row(d || '(the page folder)', `data-jump="${esc(d)}"`);
    if (here) rows += row('../', 'data-dir=".."', true);
    if (!rows) rows = `<div class="empty-note">nothing to browse — type a path below</div>`;
  }
  body += `<div style="max-height:250px;overflow:auto;border:1px solid var(--border-soft);` +
    `font-family:var(--font-mono);font-size:12px">${rows}</div>`;
  if (others > 0) {
    body += `<p class="dim" style="margin:6px 0 0">${others} other file(s) here are not shown.</p>`;
  }
  body += `<p style="margin:10px 0 0"><span class="dim">Path</span> ` +
    `<input id="srv-path" value="${esc(here)}" spellcheck="false" ` +
    `placeholder="folder or program path" ` +
    `style="width:300px;font-family:var(--font-mono)"> ` +
    `<button class="btn" id="srv-open" style="min-width:0;padding:3px 12px">Open</button>` +
    (entries ? ` <button class="btn" id="srv-usedir" style="min-width:0;padding:3px 12px" ` +
      `title="Make this the folder list_image_files ('./') reads">Use as image folder</button>` : '') +
    `</p>`;
  showModal('Browse Server Folder', body);
  const modal = document.querySelector('#modal-overlay .modal');
  if (modal) modal.style.width = '620px';
  $('#modal-ok').textContent = 'Close';

  /* a folder name walks into it, a program name opens it, a known folder jumps */
  $$('#modal-body [data-dir]').forEach(el => el.addEventListener('click', () => {
    const d = el.dataset.dir;
    showServerBrowser(d === '..' ? upDir(here) : joinPath(here, d.replace(/\/+$/, '')));
  }));
  $$('#modal-body [data-jump]').forEach(el => el.addEventListener('click', () => {
    showServerBrowser(el.dataset.jump);
  }));
  $$('#modal-body [data-prog]').forEach(el => el.addEventListener('click', () => {
    openProgramAtPath(joinPath(here, el.dataset.prog));
  }));
  const typed = () => $('#srv-path').value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  /* Open always answers: a folder is walked into, a program is fetched, and a
     path that changes nothing says so instead of redrawing the same view */
  $('#srv-open').addEventListener('click', () => {
    const p = typed();
    if (PROGRAM_FILE_RE.test(p)) { openProgramAtPath(p); return; }
    if (p === here.replace(/\/+$/, '')) {
      showServerBrowser(here, `Already showing <code>/${esc(here)}</code> — ` +
        (entries ? 'pick a folder or a program above.' : 'type another folder, e.g. <code>example</code>.'));
      return;
    }
    showServerBrowser(p);
  });
  const useDir = $('#srv-usedir');
  if (useDir) useDir.addEventListener('click', async () => {
    IMAGE_DIR = here ? here + '/' : '';
    IMAGE_DIR_HANDLE = null;
    IMAGE_URLS.clear();
    rememberProgDir(state.progFile, IMAGE_DIR);
    renderOperator();
    const found = await enumImagesAtDir('./', IMAGE_FILE_RE);
    closeModal();
    log(`Working folder: '${IMAGE_DIR || '(the page folder)'}' taken from the server — ` +
      `${found ? found.length : 0} image file(s) there. It is remembered for ` +
      `'${state.progFile}'.`, found && found.length ? 'msg' : 'warn');
  });
  $('#srv-path').addEventListener('keydown', e => { if (e.key === 'Enter') $('#srv-open').click(); });
}

/* fetch one program of the server and open it; its folder becomes the working
   folder of list_image_files ('./') */
async function openProgramAtPath(rel) {
  const clean = String(rel).replace(/^\/+/, '').replace(/\\/g, '/');
  try {
    const url = new URL(clean.split('/').map(encodeURIComponent).join('/'), appBaseUrl());
    const r = await fetch(url.href, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const text = await r.text();
    const name = decodeURIComponent(url.href.slice(url.href.lastIndexOf('/') + 1)) || 'program.odev';
    const dir = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/') + 1) : '';
    if (!loadProgram(text, name, dir)) {
      showServerBrowser(dir.replace(/\/$/, ''), `'${esc(name)}' contains no program text.`, true);
      return;
    }
    rememberProgDir(name, dir);
    rememberDir(dir);
    closeModal();
    log(`Open Program: '${clean}' fetched from the server — its folder ` +
      `'${dir || '(the page folder)'}' is the working folder of list_image_files ('./').`, 'msg');
  } catch (e) {
    const msg = `'${esc(clean)}' could not be read (${e.message}).`;
    log(`Open Program: '${clean}' could not be read (${e.message}).`, 'err');
    showServerBrowser(clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '', msg, true);
  }
}

/* both controls live in the Operator Window body, which is re-rendered often */
$('#operator-body').addEventListener('click', e => {
  if (e.target.closest('[data-loadimg]')) openImageFile();
  if (e.target.closest('[data-loadfolder]')) openImageFolder();
  if (e.target.closest('[data-setdir]')) setWorkingFolder();
  if (e.target.closest('[data-browse]')) openProgramFromServer();
  const arrow = e.target.closest('[data-pick]');      // the arrow of a value field
  if (arrow) toggleValueMenu(+arrow.dataset.pick);
});
$('#operator-body').addEventListener('change', e => {
  if (e.target.id === 'op-imgsrc') setImageSource(e.target.value);
  /* a parameter field of the Parameters tab (see paramField) — committed when
     the field loses focus */
  else if (e.target.dataset && e.target.dataset.arg !== undefined) {
    setLineArg(+e.target.dataset.arg, e.target.value, e.target.dataset.pname);
  }
});
/* a parameter field commits on Enter as well — that is what typing a value ends
   with — ArrowDown opens its value list, and Escape closes the list or puts the
   value of the line back */
$('#operator-body').addEventListener('keydown', e => {
  if (!e.target.dataset || e.target.dataset.arg === undefined) return;
  const pick = e.target.parentElement && e.target.parentElement.querySelector('[data-pick]');
  if (e.key === 'Enter') {
    e.preventDefault();
    closeValueMenu();
    setLineArg(+e.target.dataset.arg, e.target.value, e.target.dataset.pname, true);
  } else if (e.key === 'ArrowDown' && pick) {
    e.preventDefault();
    toggleValueMenu(+e.target.dataset.arg);
  } else if (e.key === 'Escape') {
    if (pvalMenu && !pvalMenu.hidden) { closeValueMenu(); return; }
    e.target.value = e.target.defaultValue;
    e.target.blur();
  }
});

/* ---------------- variable window ---------------- */
/* HDevelop semantics: every variable used by the current procedure exists in the
   variable window from the start, grayed out as undefined until it is assigned. */
function declaredVars(proc = state.proc) {
  const iconic = [], ctrl = [];
  for (const text of linesOf(proc)) {
    const p = parseLine(text);
    if (!p) continue;
    const info = OPINFO[p.op];
    if (!info) continue;
    p.args.forEach((a, i) => {
      const param = info.params[i];
      if (!param || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) return;   // skip literals
      const list = param[2] === 'iconic' ? iconic : ctrl;
      if (!list.includes(a)) list.push(a);
    });
  }
  return { iconic, ctrl };
}
const unionOrder = (declared, defined) => [...declared, ...defined.filter(k => !declared.includes(k))];

/* A region thumbnail is sampled straight from the region's pixels.  Drawing
   its baked overlay instead paints all 19.5 M pixels of the frame (130 ms) only
   to shrink the result to 80×60 — and the variable list is redrawn after every
   step, so that was the largest single cost of a loop with sub-procedures.  The
   colours and the transparency are the ones of the baked overlay
   (regionDefColor over black, DEV_OVERLAY_ALPHA below). */
function paintIconic(rec, x, w, h) {
  if (!rec) return;
  if (rec.canvas) { x.drawImage(rec.canvas, 0, 0, w, h); return; }
  const W = rec.mat ? rec.mat.cols : rec.w;
  const H = rec.mat ? rec.mat.rows : rec.h;
  if (!W || !H) return;
  /* An image whose display canvas has not been built yet (a mean_image result
     that only feeds another operator) is sampled as gray values — the region
     branch below would read its pixels as a mask and fill the whole thumbnail. */
  if (rec.kind === 'image') {
    const g = rec.mat ? rec.mat.data : rec.gray;
    if (!g) return;
    if (rec.mat && rec.mat.channels && rec.mat.channels() !== 1) {
      const c = recCanvas(rec);                      // colour source: bake it
      if (c) x.drawImage(c, 0, 0, w, h);
      return;
    }
    const id = x.createImageData(w, h), d = id.data;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(H - 1, ((y + 0.5) * H / h) | 0) * W;
      for (let k = 0; k < w; k++) {
        const v = g[sy + Math.min(W - 1, ((k + 0.5) * W / w) | 0)] || 0;
        const q = (y * w + k) * 4;
        d[q] = d[q + 1] = d[q + 2] = v; d[q + 3] = 255;
      }
    }
    x.putImageData(id, 0, 0);
    return;
  }
  const mask = rec.mat ? rec.mat.data : null;
  const labels = mask ? null : rec.labels;
  if (!mask && !labels) return;
  if (!mask && rec.ids && !rec._idsSet) rec._idsSet = new Set(rec.ids);
  const alpha = mask ? 150 : 165;                   // the alpha of the baked overlay
  const id = x.createImageData(w, h), d = id.data;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(H - 1, ((y + 0.5) * H / h) | 0) * W;
    for (let k = 0; k < w; k++) {
      const si = sy + Math.min(W - 1, ((k + 0.5) * W / w) | 0);
      const lab = labels ? labels[si] : 1;
      if (mask ? !mask[si] : (!lab || (rec._idsSet && !rec._idsSet.has(lab)))) continue;
      const col = regionDefColor(rec, lab);
      const q = (y * w + k) * 4;
      d[q] = col[0] * alpha / 255; d[q + 1] = col[1] * alpha / 255; d[q + 2] = col[2] * alpha / 255;
      d[q + 3] = 255;
    }
  }
  x.putImageData(id, 0, 0);
}

function renderVariables() {
  const body = $('#variable-body');
  const decl = declaredVars();
  if (state.varsTab === 'control') {
    const names = unionOrder(decl.ctrl, [...state.ctrl.keys()]);
    body.innerHTML = names.length
      ? `<table class="ctrl-table">` + names.map(k => {
          const v = state.ctrl.get(k);
          return `<tr data-cname="${k}" class="${state.selectedCtrl === k ? 'selected' : ''} ${v ? '' : 'undefined'}">` +
            `<td class="cname"><button class="vcard-watch ${state.watch.has(k) ? 'watched' : ''}" title="Watch / unwatch">W</button>${k}</td>` +
            `<td class="cval">${v ? esc(String(v.value)) : '<span class="dim">undefined</span>'}</td>` +
            `<td class="ctype">${v ? v.type : '—'}</td></tr>`;
        }).join('') + `</table>`
      : '<div class="empty-note">This procedure uses no control variables.</div>';
    updateVarDetails();
    return;
  }
  const names = unionOrder(decl.iconic, [...state.iconic.keys()]);
  body.innerHTML = names.length
    ? `<div class="iconic-grid">` + names.map(k => {
        const rec = state.iconic.get(k);
        const shown = gfxShownIn(k);
        return `<div class="vcard ${state.selectedVar === k ? 'selected' : ''} ${shown.length ? 'onair' : ''} ${rec ? '' : 'undefined'}" data-var="${k}" title="Click to select · double-click to display (dev_display)${shown.length ? ` · displayed in window ${shown.join(', ')}` : ''}">` +
          `<button class="vcard-watch ${state.watch.has(k) ? 'watched' : ''}" title="Watch / unwatch">W</button>` +
          (shown.length ? `<span class="vcard-win" title="Displayed in window ${shown.join(', ')}">▣ ${shown.join(',')}</span>` : '') +
          `<canvas width="80" height="60"></canvas>` +
          `<span class="vname">${k}</span><span class="vtype">${rec ? rec.type : 'undefined'}</span></div>`;
      }).join('') + `</div>`
    : '<div class="empty-note">This procedure uses no iconic variables.</div>';
  $$('.vcard canvas', body).forEach(cv => {
    const rec = state.iconic.get(cv.parentElement.dataset.var);
    const x = cv.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, 80, 60);
    if (rec) paintIconic(rec, x, 80, 60);
  });
  updateVarDetails();
}

function updateVarDetails() {
  const el = $('#vw-details');
  if (!el) return;
  if (state.varsTab === 'control') {
    const name = state.selectedCtrl;
    const v = name && state.ctrl.get(name);
    el.textContent = !name ? 'Select a variable'
      : v ? `${name}: ${v.type} = ${v.value}`
      : `${name}: undefined (not assigned yet)`;
    return;
  }
  const name = state.selectedVar;
  const rec = name && state.iconic.get(name);
  if (!rec) {
    const decl = declaredVars();
    el.textContent = !name ? 'Select a variable'
      : decl.iconic.includes(name) || state.watch.has(name) ? `${name}: undefined (not assigned yet)`
      : 'Select a variable';
    return;
  }
  let s = `${name}: ${rec.type || rec.kind}`;
  if (rec.mat) s += ` · ${rec.mat.cols}×${rec.mat.rows}`;
  if (rec.count) s += ` · ${rec.count} objects`;
  el.textContent = s;
}

/* ---------------- graphics windows (HDevelop-style: several per program) ----------------
   Every graphics window — the docked one (handle 1) and each dev_open_window
   spawn — is built from gfxBodyHtml, so all carry the same toolbar, panels and
   status bar. Tool state (tool / profileLine / drag / view / fit) lives per
   window. dev_display outputs to the active window: the one opened last, or
   the one selected via dev_set_window. */
const GFX = { seq: 1, wins: new Map(), active: 1 };

/* --------------------------------------------------------------------------
   HDevelop graphics-window display parameters
   dev_set_color / dev_set_colored / dev_set_draw / dev_set_line_width stay in
   effect until they are changed and are inherited by every graphics window
   opened afterwards.  `color: null` keeps the per-object default colours of
   this build (baked canvases), so an untouched program looks as before.
   -------------------------------------------------------------------------- */
const DEV_PARAMS = { color: null, colored: 0, draw: 'fill', lineWidth: 1 };
const DEV_NAMED = {
  black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], grey: [128, 128, 128],
  red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], cyan: [0, 255, 255],
  magenta: [255, 0, 255], yellow: [255, 255, 0],
};
/* 'name' | '#rrggbb' | '#rrggbbaa' -> [r, g, b, a in 0..1], null if unknown */
function devColor(name) {
  const s = String(name == null ? '' : name).replace(/'/g, '').trim();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) {
    const n = i => parseInt(s.substr(i, 2), 16);
    return [n(1), n(3), n(5), s.length === 9 ? n(7) / 255 : 1];
  }
  const c = DEV_NAMED[s.toLowerCase()];
  return c ? [...c, 1] : null;
}
const devCss = c => (c ? `rgba(${c[0]},${c[1]},${c[2]},${c[3]})` : null);

/* dev_open_window Background: named colour, gray value (0..255) or packed
   RGB; -1 means "no background is painted" (HDevelop leaves it uninitialised,
   here the window keeps the IDE's dark background). */
function devBg(name) {
  const s = String(name == null ? '' : name).replace(/'/g, '').trim().toLowerCase();
  const named = { black: '#101112', white: '#d8d8d8', gray: '#3c3f43', grey: '#3c3f43' };
  if (named[s]) return named[s];
  if (/^-?\d+$/.test(s)) {
    const v = parseInt(s, 10);
    if (v === -1) return '#101112';
    if (v <= 255) return `rgb(${v},${v},${v})`;
    return `rgb(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255})`;
  }
  return '#101112';
}

/* default paint colour of a region record (matches the baked overlays) */
function regionDefColor(rec, label) {
  if (rec.mat) return [236, 70, 60];
  if (rec.ids) return [80, 200, 120];
  return hslToRgb((label * 47) % 360, 75, 55);
}

/* The display canvas of a region result is built on first use, not when the
   operator returns: painting 19.5 M pixels costs ~130 ms, and a program that
   runs with dev_update_off () - or that uses a result only to measure it -
   never shows it.  Every consumer of the pixels goes through here, so a
   result is still displayed exactly as before. */
function recCanvas(rec) {
  if (!rec) return null;
  if (!rec.canvas && typeof rec.canvasFor === 'function') {
    const build = rec.canvasFor;
    rec.canvasFor = null;
    rec.canvas = build();
  }
  return rec.canvas || null;
}

/* Repaint a region record with the window's display parameters (dev_set_color /
   dev_set_colored / dev_set_draw('margin') / dev_set_line_width).  Returns null
   when the baked canvas already matches, i.e. the common case of no explicit
   colour and filled regions. */
function regionParamCanvas(rec, p) {
  if (!p.color && !p.colored && p.draw !== 'margin') return null;
  const W = rec.w || (rec.mat && rec.mat.cols), H = rec.h || (rec.mat && rec.mat.rows);
  if (!W || !H) return null;
  const key = `${p.color || ''}|${p.colored}|${p.draw}|${p.lineWidth}`;
  if (rec._paint && rec._paint.key === key) return rec._paint.canvas;

  const mask = rec.mat ? rec.mat.data : null;
  const labels = mask ? null : rec.labels;
  if (!mask && !labels) return null;
  if (!mask && rec.ids && !rec._idsSet) rec._idsSet = new Set(rec.ids);
  const inside = i => mask ? mask[i] !== 0
    : (labels[i] !== 0 && (!rec._idsSet || rec._idsSet.has(labels[i])));

  const explicit = devColor(p.color);
  const margin = p.draw === 'margin';
  const lw = Math.max(1, (p.lineWidth | 0) || 1);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const id = x.createImageData(W, H), d = id.data;
  const colOf = label => explicit ? explicit
    : [...(p.colored ? hslToRgb((label * 47) % 360, 75, 55) : regionDefColor(rec, label)), 1];
  for (let y = 0; y < H; y++) {
    for (let xx = 0; xx < W; xx++) {
      const i = y * W + xx;
      if (!inside(i)) continue;
      if (margin) {                                   // dev_set_draw ('margin'): outline only
        const edge = (xx === 0 || !inside(i - 1)) || (xx === W - 1 || !inside(i + 1)) ||
                     (y === 0 || !inside(i - W)) || (y === H - 1 || !inside(i + W));
        if (!edge) continue;
      }
      const cc = colOf(labels ? labels[i] : 1);
      const q = i * 4;
      d[q] = cc[0]; d[q + 1] = cc[1]; d[q + 2] = cc[2]; d[q + 3] = margin ? 255 : Math.round(cc[3] * 255);
    }
  }
  x.putImageData(id, 0, 0);
  if (margin && lw > 1) {                             // dev_set_line_width
    const t = document.createElement('canvas');
    t.width = W; t.height = H;
    t.getContext('2d').drawImage(c, 0, 0);
    const r = Math.floor(lw / 2);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx || dy) x.drawImage(t, dx, dy);
  }
  rec._paint = { key, canvas: c };
  return c;
}

/* XLD contours are vectors, so they can always be stroked with the current
   dev_set_color / dev_set_line_width (line width stays constant on screen). */
function paintXld(g2, rec, p, G) {
  g2.strokeStyle = devCss(devColor(p.color)) || 'rgba(88,220,120,0.95)';
  g2.lineWidth = Math.max(1, p.lineWidth || 1) / (G.view.scale || 1);
  for (const cont of (rec.xld || [])) {
    const xs = cont.x, ys = cont.y;
    if (!xs || !xs.length) continue;
    g2.beginPath();
    for (let i = 0; i < xs.length; i++) i ? g2.lineTo(xs[i], ys[i]) : g2.moveTo(xs[i], ys[i]);
    g2.stroke();
  }
}

function paintObject(g2, rec, p, G) {
  if (rec.kind === 'xld') { paintXld(g2, rec, p, G); return; }
  const pc = regionParamCanvas(rec, p);
  if (pc) { g2.drawImage(pc, 0, 0); return; }
  const c = recCanvas(rec);
  if (c) g2.drawImage(c, 0, 0);
}

/* disp_message (Row / Column / ColorName / Box, CoordSystem 'window'|'image') */
function paintMessage(g2, m, G) {
  g2.font = '13px "Segoe UI", sans-serif';
  let x0 = Number(m.col) || 0, y0 = Number(m.row) || 0;
  if (m.cs === 'image') { x0 = x0 * G.view.scale + G.view.ox; y0 = y0 * G.view.scale + G.view.oy; }
  const tw = g2.measureText(m.text).width;
  if (m.box !== 'false') {
    g2.fillStyle = 'rgba(0,0,0,0.65)';
    g2.fillRect(x0 - 3, y0 - 2, tw + 12, 20);
  }
  g2.fillStyle = devCss(devColor(m.color)) || '#4caf50';
  g2.fillText(m.text, x0 + 3, y0 + 12);
}

/* disp_cross / disp_circle / disp_ellipse / disp_line / disp_arrow /
   disp_rectangle1 / disp_rectangle2 / disp_polygon draw directly into a
   window.  HALCON keeps no iconic result for them, so they are stored in the
   window's display history as primitives instead of an iconic variable.
   All coordinates are image coordinates (Row = y, Column = x), as everywhere
   else in this build. */
function paintPrimitive(g2, prim, p, G) {
  const color = devCss(devColor(p && p.color)) || 'rgba(88,220,120,0.95)';
  g2.strokeStyle = color; g2.fillStyle = color;
  g2.lineWidth = Math.max(1, (p && p.lineWidth) || 1) / (G.view.scale || 1);
  const filled = (p && p.draw) !== 'margin';        // dev_set_draw ('fill' / 'margin')
  const line = (x1, y1, x2, y2) => { g2.beginPath(); g2.moveTo(x1, y1); g2.lineTo(x2, y2); g2.stroke(); };
  const closed = (xs, ys) => {
    g2.beginPath();
    for (let i = 0; i < xs.length; i++) i ? g2.lineTo(xs[i], ys[i]) : g2.moveTo(xs[i], ys[i]);
    g2.closePath();
    if (filled && xs.length > 2) g2.fill(); else g2.stroke();
  };
  for (const s of (prim.shapes || [])) {
    switch (prim.kind) {
      case 'cross': {                               // Size = total length, Angle in radians
        const a = s.angle || 0, ca = Math.cos(a), sa = Math.sin(a), k = (s.size || 0) / 2;
        line(s.col + k * ca, s.row - k * sa, s.col - k * ca, s.row + k * sa);
        line(s.col - k * sa, s.row - k * ca, s.col + k * sa, s.row + k * ca);
        break;
      }
      case 'line':
        line(s.col1, s.row1, s.col2, s.row2);
        break;
      case 'arrow': {                               // head of length Size at (Row2, Column2)
        line(s.col1, s.row1, s.col2, s.row2);
        const a = Math.atan2(s.row2 - s.row1, s.col2 - s.col1);
        const h = Math.max(2, s.size || 0), w = Math.max(1, h / 3);
        const bx = s.col2 - h * Math.cos(a), by = s.row2 - h * Math.sin(a);
        g2.beginPath();
        g2.moveTo(s.col2, s.row2);
        g2.lineTo(bx + w * Math.sin(a), by - w * Math.cos(a));
        g2.lineTo(bx - w * Math.sin(a), by + w * Math.cos(a));
        g2.closePath();
        g2.fill();
        break;
      }
      case 'circle':
        g2.beginPath();
        g2.arc(s.col, s.row, Math.max(0, s.radius || 0), 0, Math.PI * 2);
        filled ? g2.fill() : g2.stroke();
        break;
      case 'ellipse':                               // Phi in radians, from the column axis
        g2.beginPath();
        g2.ellipse(s.col, s.row, Math.max(0, s.ra || 0), Math.max(0, s.rb || 0), s.phi || 0, 0, Math.PI * 2);
        filled ? g2.fill() : g2.stroke();
        break;
      case 'rectangle1': {
        const y0 = Math.min(s.row1, s.row2), y1 = Math.max(s.row1, s.row2);
        const x0 = Math.min(s.col1, s.col2), x1 = Math.max(s.col1, s.col2);
        const w = Math.max(g2.lineWidth, x1 - x0), h = Math.max(g2.lineWidth, y1 - y0);
        if (filled) g2.fillRect(x0, y0, w, h); else g2.strokeRect(x0, y0, w, h);
        break;
      }
      case 'rectangle2': {                          // Length1/Length2 = half side lengths
        const a = s.phi || 0, ca = Math.cos(a), sa = Math.sin(a);
        const l1 = s.length1 || 0, l2 = s.length2 || 0;
        const xs = [], ys = [];
        for (const [u, v] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
          xs.push(s.col + ca * u * l1 - sa * v * l2);
          ys.push(s.row + sa * u * l1 + ca * v * l2);
        }
        closed(xs, ys);
        break;
      }
      case 'polygon':
        if (s.cols && s.cols.length > 1) closed(s.cols, s.rows);
        break;
    }
  }
}

/* ---- per-window display history -------------------------------------------
   HDevelop keeps, for each graphics window, the objects and display parameters
   that have been displayed since the most recent clear action or display of a
   full image, and redraws them (e.g. when the window is resized).  G.items is
   that history; G.base is the full image underneath it.
   -------------------------------------------------------------------------- */
function gfxResetPart(G, force = false) {
  G.part = null;
  if (force) setFitChecked(G, true);      // a freshly read image turns Fit on again
  if (force || fitChecked(G)) fitView(G);
  else { G.view.scale = 1; G.view.ox = 0; G.view.oy = 0; }
}
/* `fit` is set by read_image: a newly read image is fitted to the window even
   when the user had zoomed or panned it (and even when the new frame happens to
   have the same size as the previous one, which used to keep the old view). */
function gfxShowImage(G, name, fit = false) {   // display of a full image -> clears the history
  const rec = state.iconic.get(name);
  const prev = G.base && state.iconic.get(G.base);
  const c = recCanvas(rec);               // a lazy canvas is built now: it is shown
  const pcv = recCanvas(prev);
  G.base = name;
  G.items.length = 0;
  if (c && (fit || !pcv || pcv.width !== c.width || pcv.height !== c.height)) gfxResetPart(G, fit);
  renderGraphics(G);
  updateStatusSize(G);
}
function gfxShowItem(G, name) {           // dev_display / double click on a variable
  const rec = state.iconic.get(name);
  if (!rec) throw new Error(`dev_display: iconic object '${name}' is not defined`);
  if (rec.kind === 'image') { gfxShowImage(G, name); return; }
  const idx = G.items.findIndex(it => it.name === name);
  if (idx >= 0) G.items.splice(idx, 1);
  G.items.push({ name, p: Object.assign({}, G.params) });
  renderGraphics(G);
}
function gfxShowMessage(G, text, props) {
  const m = Object.assign({ row: 12, col: 12, color: 'green', box: 'true', cs: 'window' }, props || {}, { text });
  G.items = G.items.filter(it => !(it.msg && it.msg.text === text));
  G.items.push({ msg: m });
  renderGraphics(G);
}

/* disp_* drawing primitives join the display history at the position they were
   drawn, each with the display parameters (dev_set_color / _line_width /
   _draw) that were in effect for the call. */
function gfxShowPrimitive(G, prim) {
  G.items.push({ prim, p: Object.assign({}, G.params) });
  renderGraphics(G);
}
function gfxSetParams(G, patch) {
  Object.assign(DEV_PARAMS, patch);       // inherited by windows opened later on
  Object.assign(G.params, patch);
}
/* dev_set_part: fit the rectangle of the image into the window */
function gfxSetPart(G, r1, c1, r2, c2) {
  const { W, H } = gfxImageSize(G);       // the frame that is shown (rec.mat wins)
  const cols = Math.max(1, G.canvas.width), rows = Math.max(1, G.canvas.height);
  let y0 = Math.max(0, r1), x0 = Math.max(0, c1), y1 = r2, x1 = c2;
  if (!(y1 > y0) || y1 < 0) y1 = H - 1;   // Row1 > Row2 / negative: reset that dimension
  if (!(x1 > x0) || x1 < 0) x1 = W - 1;
  y1 = Math.min(y1, H - 1); x1 = Math.min(x1, W - 1);
  const s = Math.min(cols / (x1 - x0 + 1), rows / (y1 - y0 + 1));
  G.view.scale = s;
  G.view.ox = (cols - (x1 - x0 + 1) * s) / 2 - x0 * s;
  G.view.oy = (rows - (y1 - y0 + 1) * s) / 2 - y0 * s;
  G.part = { r1: y0, c1: x0, r2: y1, c2: x1 };
  setFitChecked(G, false);                // an explicit part overrides 'Fit'
  updateZoomLabel(G);
  renderGraphics(G);
}

function gfxBodyHtml(bg) {
  return `
  <div class="gtoolbar">
    <button class="gt-btn gactive" data-gcmd="active" title="Active window: dev_display and operator results are output to this window (HDevelop's active-window lamp / dev_set_window)"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="none" stroke="currentColor"/><path d="M8 .5v2M8 13.5v2M.5 8h2M13.5 8h2M2.7 2.7l1.4 1.4M11.9 11.9l1.4 1.4M13.3 2.7l-1.4 1.4M4.1 11.9l-1.4 1.4" stroke="currentColor"/></svg></button>
    <span class="tb-sep"></span>
    <button class="gt-btn active" data-tool="move" title="Move image (Alt: zoom out)"><svg viewBox="0 0 16 16"><path d="M8 1v14M1 8h14" stroke="currentColor"/><path d="M8 1L6 3m2-2l2 2M8 15l-2-2m2 2l2-2M1 8l2-2m-2 2l2 2M15 8l-2-2m2 2l-2 2" stroke="currentColor"/></svg></button>
    <button class="gt-btn" data-tool="zoom" title="Zoom image (left: in, right: out)"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor"/><path d="M11 11l4 4" stroke="currentColor"/><path d="M7 4.5v5M4.5 7h5" stroke="currentColor"/></svg></button>
    <button class="gt-btn" data-tool="select" title="Select: click a region element or an XLD contour to inspect its features (Visualization ▸ Feature Inspection)"><svg viewBox="0 0 16 16"><path d="M3.5 1.5l8 7-3.6.5 2.2 3.8-1.6.9-2.2-3.8-2.8 3.1z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg></button>
    <span class="tb-sep"></span>
    <button class="gt-btn" data-gcmd="zoomout" title="Zoom out"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor"/><path d="M11 11l4 4" stroke="currentColor"/><path d="M4.5 7h5" stroke="currentColor"/></svg></button>
    <button class="gt-btn" data-gcmd="fit" title="Fit window"><svg viewBox="0 0 16 16"><path d="M1 5V1h4M15 5V1h-4M1 11v4h4M15 11v4h-4" fill="none" stroke="currentColor"/></svg></button>
    <button class="gt-btn" data-gcmd="redraw" title="Redraw"><svg viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 1-5.6 3.8" fill="none" stroke="currentColor"/><path d="M2 1v5h5" fill="none" stroke="currentColor"/></svg></button>
    <span class="tb-sep"></span>
    <button class="gt-btn" data-gcmd="profile" title="Profile: drag a line"><svg viewBox="0 0 16 16"><path d="M1 13L5 6l3 4 3-7 4 10" fill="none" stroke="currentColor"/></svg></button>
    <button class="gt-btn" data-gcmd="histogram" title="Histogram"><svg viewBox="0 0 16 16"><path d="M2 14V9M6 14V4M10 14V7M14 14V2" stroke="currentColor"/></svg></button>
    <button class="gt-btn" data-gcmd="plot3d" title="3D plot"><svg viewBox="0 0 16 16"><path d="M8 1l6 3v8l-6 3-6-3V4z" fill="none" stroke="currentColor"/><path d="M8 1v8M8 9l6-5M8 9l-6-5" fill="none" stroke="currentColor"/></svg></button>
    <span class="tb-sep"></span>
    <button class="gt-btn" data-gcmd="live" title="Live camera (grab loop while a frame grabber is open)"><svg viewBox="0 0 16 16"><rect x="1.5" y="4" width="13" height="8.5" rx="1.5" fill="none" stroke="currentColor"/><circle cx="8" cy="8.2" r="2.4" fill="none" stroke="currentColor"/><circle cx="8" cy="8.2" r="0.9" fill="currentColor"/></svg></button>
    <span class="tb-sep"></span>
    <button class="gt-btn" data-gcmd="metrology" title="Metrology overlay: show/hide measure regions and fitted contours (apply_metrology_model)"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke="currentColor"/></svg></button>
    <span class="tb-sep"></span>
    <span class="gtools-hint"></span>
    <span class="grow"></span>
    <span class="gt-label">Zoom:</span><span class="gt-value zoom-value">100%</span>
    <label class="gt-check"><input type="checkbox" class="fit-check"> Fit</label>
  </div>
  <div class="gcanvas-wrap" style="background:${bg}"><canvas></canvas>
    <div class="gpanel hidden profile-panel">
      <div class="gpanel-title">Profile <button class="gpanel-x" data-close="profile-panel">&times;</button></div>
      <canvas class="profile-canvas" width="300" height="110"></canvas>
    </div>
    <div class="gpanel hidden histogram-panel">
      <div class="gpanel-title">Histogram <button class="gpanel-x" data-close="histogram-panel">&times;</button></div>
      <canvas class="histogram-canvas" width="300" height="110"></canvas>
    </div>
    <div class="gpanel hidden plot-panel">
      <div class="gpanel-title">Plot: <span class="plot-title-var"></span> <button class="gpanel-x" data-close="plot-panel">&times;</button></div>
      <canvas class="plot-canvas" width="300" height="110"></canvas>
    </div>
  </div>
  <div class="gstatus">
    <span class="gstatus-gray">Gray: &mdash;</span>
    <span class="gstatus-pos">Row: &mdash; Col: &mdash;</span>
    <span class="grow"></span>
    <span class="gstatus-size">&mdash;</span>
  </div>`;
}

function makeGfxRec(o) {
  const rec = Object.assign({
    view: { scale: 1, ox: 0, oy: 0 },
    base: null, items: [], metrology: null, showMetrology: true,
    params: Object.assign({}, DEV_PARAMS),          // dev_set_color/_colored/_draw/_line_width
    part: null,                                     // dev_set_part
    tool: 'move', profileLine: null, drag: null, plotVar: null,
    bg: '#101112', ro: null,
    spawned: o.handle !== 1,
  }, o);
  rec.g2d = rec.canvas.getContext('2d');
  GFX.wins.set(rec.handle, rec);
  return rec;
}

/* docked Graphics Window gets the same body as every spawn */
$('#win-graphics').insertAdjacentHTML('beforeend', gfxBodyHtml('#101112'));
const mainGfx = makeGfxRec({
  handle: 1, winId: 'win-graphics', el: $('#win-graphics'),
  wrap: $('#win-graphics .gcanvas-wrap'), canvas: $('#win-graphics .gcanvas-wrap > canvas'),
});
const gfxActive = () => GFX.wins.get(GFX.active) || mainGfx;
/* handles of the windows that currently show this iconic object (HDevelop keeps
   such a reference per variable and the Variable Window can list it) */
const gfxShownIn = name => [...GFX.wins.values()]
  .filter(g => g.base === name || g.items.some(it => it.name === name))
  .map(g => g.handle);
const gfxOnAir = name => gfxShownIn(name).length > 0;
/* HDevelop's active-window lamp: exactly one graphics window receives the
   output of dev_display and of the automatically displayed operator results. */
function refreshActiveLamps() {
  GFX.wins.forEach(g => {
    const b = $('.gt-btn.gactive', g.el);
    if (b) b.classList.toggle('active', g.handle === GFX.active);
    if (g.el) g.el.classList.toggle('gfx-active', g.handle === GFX.active);
  });
}
const fitChecked = G => { const f = $('.fit-check', G.el); return !!(f && f.checked); };
function setFitChecked(G, v) { const f = $('.fit-check', G.el); if (f) f.checked = v; }

/* The size of the image a window shows.  It is the frame that was read — 5088×3840
   for the example program's photos, not the 640×480 demo chip — so 'Fit' and the
   gray probe must ask the base image, not the workspace default: fitting a large
   photo with the demo size picks a scale ~8× too large, which shows a magnified
   corner instead of the whole image. */
function gfxImageSize(G) {
  const rec = G.base && state.iconic.get(G.base);
  if (rec && rec.mat) return { W: rec.mat.cols, H: rec.mat.rows };
  if (rec && rec.canvas) return { W: rec.canvas.width, H: rec.canvas.height };
  return { W: IMG_W, H: IMG_H };
}

function fitView(G) {
  const r = G.wrap.getBoundingClientRect();
  if (r.width < 20 || r.height < 20) return;
  const { W, H } = gfxImageSize(G);              // the image that is actually shown
  const s = Math.min(r.width / W, r.height / H) * 0.98;
  G.view.scale = s;
  G.view.ox = (r.width - W * s) / 2;
  G.view.oy = (r.height - H * s) / 2;
  updateZoomLabel(G);
}
function updateZoomLabel(G) {
  const el = $('.zoom-value', G.el);
  if (el) el.textContent = Math.round(G.view.scale * 100) + '%';
}

function sizeGfxCanvas(G) {
  const r = G.wrap.getBoundingClientRect();
  G.canvas.width = Math.max(50, r.width | 0);
  G.canvas.height = Math.max(50, r.height | 0);
}

/* canvas size + optional fit + status: shared by all windows */
function layoutGfx(G) {
  sizeGfxCanvas(G);
  if (fitChecked(G)) fitView(G);
  renderGraphics(G);
  updateStatusSize(G);
}
function resizeGraphics() { layoutGfx(mainGfx); }   // docked window (WM call sites)
function updateStatusSize(G) {
  const el = $('.gstatus-size', G.el);
  if (!el) return;
  const rec = G.base && state.iconic.get(G.base);
  const cv = rec && rec.canvas, mt = rec && rec.mat;
  el.textContent = cv ? `${cv.width} × ${cv.height}`
    : (mt ? `${mt.cols} × ${mt.rows}` : '—');
}

function renderGraphics(G = gfxActive()) {
  const w = G.canvas.width, h = G.canvas.height;
  const g2 = G.g2d;
  g2.setTransform(1, 0, 0, 1, 0, 0);
  g2.fillStyle = G.bg;
  g2.fillRect(0, 0, w, h);
  g2.imageSmoothingEnabled = G.view.scale < 1;
  g2.save();
  g2.setTransform(G.view.scale, 0, 0, G.view.scale, G.view.ox, G.view.oy);
  const baseRec = G.base && state.iconic.get(G.base);
  const baseCv = baseRec && recCanvas(baseRec);
  if (baseCv) g2.drawImage(baseCv, 0, 0);
  /* window history: regions / XLD / disp_* primitives on top of the image, in
     the order they were displayed, each with the display parameters of its call */
  for (const it of G.items) {
    if (it.msg) continue;
    if (it.prim) { paintPrimitive(g2, it.prim, it.p || DEV_PARAMS, G); continue; }
    if (!it.name) continue;
    const rec = state.iconic.get(it.name);
    if (rec && rec.kind !== 'image') paintObject(g2, rec, it.p || DEV_PARAMS, G);
  }
  if (G.metrology && G.showMetrology !== false) g2.drawImage(G.metrology, 0, 0);
  // the element the Feature Inspection window measures
  const fiHl = featHighlight(G);
  if (fiHl) drawFeatHighlight(g2, G, fiHl);
  // profile line
  if (G.profileLine) {
    g2.strokeStyle = '#ffd54f'; g2.lineWidth = 1.5 / G.view.scale;
    g2.beginPath();
    g2.moveTo(G.profileLine.x1, G.profileLine.y1);
    g2.lineTo(G.profileLine.x2, G.profileLine.y2);
    g2.stroke();
  }
  g2.restore();
  // disp_message (drawn in window coordinates, on top of everything)
  for (const it of G.items) if (it.msg) paintMessage(g2, it.msg, G);
  // zoom rubber band
  if (G.drag && G.drag.kind === 'zoom') {
    const d = G.drag;
    g2.strokeStyle = '#4da3ff';
    g2.lineWidth = 1;
    g2.setLineDash([4, 3]);
    g2.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1),
                  Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    g2.setLineDash([]);
  }
  updateZoomLabel(G);
}

function canvasToImage(G, e) {
  const r = G.canvas.getBoundingClientRect();
  const cx = e.clientX - r.left, cy = e.clientY - r.top;
  return { x: (cx - G.view.ox) / G.view.scale, y: (cy - G.view.oy) / G.view.scale, cx, cy };
}

function currentImage(G) {
  const rec = G.base && state.iconic.get(G.base);
  return rec && rec.gray ? rec : null;
}
function grayAt(G, x, y) {
  const rec = currentImage(G);
  if (!rec) return null;
  const { W, H } = gfxImageSize(G);          // the stride rec.gray was built with
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  return rec.gray[((y | 0) * W) + (x | 0)];
}

function zoomAt(G, cx, cy, f) {
  const s = Math.min(40, Math.max(0.05, G.view.scale * f));
  const k = s / G.view.scale;
  G.view.ox = cx - (cx - G.view.ox) * k;
  G.view.oy = cy - (cy - G.view.oy) * k;
  G.view.scale = s;
  setFitChecked(G, false);
  renderGraphics(G);
}

/* zoom so the given canvas-space rectangle fills the view (rubber-band zoom) */
function applyZoomRect(G, x, y, w, h) {
  const cw = G.canvas.width, ch = G.canvas.height;
  const s = Math.min(40, Math.max(0.05, Math.min(cw / w, ch / h) * 0.95));
  G.view.scale = s;
  G.view.ox = (cw - w * s) / 2 - x * s;
  G.view.oy = (ch - h * s) / 2 - y * s;
  setFitChecked(G, false);
  renderGraphics(G);
}

/* ---------------- spawned graphics windows (dev_open_window) ---------------- */
function gfxOpen(opts) {
  const handle = ++GFX.seq;
  const winId = 'gfxwin-' + handle;
  const bg = devBg(opts.background);
  const el = document.createElement('div');
  el.className = 'window gfx-win floating';
  el.id = winId;
  el.innerHTML =
    `<div class="titlebar"><span class="tb-icon win"></span>` +
    `<span class="title">Graphics Window ${handle}</span>` +
    `<span class="titlebar-btns">` +
    `<button class="wbtn min" title="Minimize"></button>` +
    `<button class="wbtn max" title="Maximize"></button>` +
    `<button class="wbtn close" title="Close"></button></span></div>` +
    gfxBodyHtml(bg);
  wmRow().appendChild(el);

  const rec = makeGfxRec({ handle, winId, el, wrap: $('.gcanvas-wrap', el), canvas: $('.gcanvas-wrap > canvas', el), bg });

  const rowR = wmRow().getBoundingClientRect();
  const W = Math.max(220, opts.width | 0), H = Math.max(170, opts.height | 0);
  const off = 26 * (GFX.wins.size - 2);            // slight cascade so windows don't stack exactly
  wmApplyRect(el, {
    x: Math.min(Math.max(0, (opts.col | 0) + off), Math.max(0, rowR.width - 140)),
    y: Math.min(Math.max(0, (opts.row | 0) + off), Math.max(0, rowR.height - 40)),
    w: W, h: H + 26,                               // + titlebar
  });

  wmWire(el);
  $('.wbtn.min', el).addEventListener('click', () => wmMinimize(winId));
  $('.wbtn.max', el).addEventListener('click', () => wmToggleMax(el));
  $('.wbtn.close', el).addEventListener('click', () => gfxClose(handle));
  $('.titlebar', el).addEventListener('dblclick', e => {
    if (e.target.closest('.wbtn')) return;
    if (performance.now() - (wmRec(winId).dragMoved || 0) < 250) return;
    wmToggleMax(el);
  });

  wireGfxWindow(rec);
  setFitChecked(rec, true);
  layoutGfx(rec);

  GFX.active = handle;                             // a new window is active (HDevelop)
  refreshActiveLamps();
  wmRaise(el);
  updateSplitters();
  renderTaskbar();
  return handle;
}

function gfxClose(handle) {
  const G = GFX.wins.get(handle);
  if (!G) throw new Error(`close_window: invalid window handle ${handle}`);
  if (G === mainGfx) {
    /* HDevelop's dev_close_window closes the active *floating* window only; the
       docked IDE window cannot be destroyed, so it is cleared instead. */
    G.base = null; G.items = []; G.metrology = null;
    renderGraphics(G);
    log("dev_close_window: the docked Graphics Window cannot be closed — cleared instead.", 'warn');
    return;
  }
  if (G.ro) G.ro.disconnect();
  delete WM.recs[G.winId];
  G.el.remove();
  GFX.wins.delete(handle);
  if (GFX.active === handle) GFX.active = 1;
  refreshActiveLamps();
  updateSplitters();
  renderTaskbar();
}

/* dev windows are runtime-only: close them all on reset / fresh run */
function gfxCloseSpawned() {
  [...GFX.wins.keys()].forEach(h => {
    if (h === 1) return;
    const G = GFX.wins.get(h);
    if (G.ro) G.ro.disconnect();
    delete WM.recs[G.winId];
    G.el.remove();
    GFX.wins.delete(h);
  });
  GFX.active = 1;
  refreshActiveLamps();
  /* the taskbar/stack buttons of the closed windows must go with them */
  updateSplitters();
  renderTaskbar();
}

function gfxSetActive(handle) {
  const G = GFX.wins.get(handle);
  if (!G) throw new Error(`dev_set_window: invalid window handle ${handle}`);
  GFX.active = handle;
  if (wmRec(G.winId).mode === 'floating') wmRaise(G.el);
  refreshActiveLamps();
}

/* ---------------- graphics window wiring: identical for every window ---------------- */
function wireGfxWindow(G) {
  const el = G.el;

  $$('.gt-btn[data-tool]', el).forEach(b => b.addEventListener('click', () => {
    $$('.gt-btn[data-tool]', el).forEach(o => o.classList.remove('active'));
    b.classList.add('active');
    G.tool = b.dataset.tool;
    G.canvas.classList.toggle('tool-zoom', G.tool === 'zoom');
    G.canvas.classList.toggle('tool-profile', G.tool === 'profile');
    G.canvas.classList.toggle('tool-select', G.tool === 'select');
    const hint = $('.gtools-hint', el);
    if (hint) hint.textContent = G.tool === 'profile' ? 'Drag a line in the image'
      : G.tool === 'select' ? 'Click a region or XLD contour to inspect it' : '';
    if (typeof syncFeatPick === 'function') syncFeatPick();
  }));

  $$('.gt-btn[data-gcmd]', el).forEach(b => b.addEventListener('click', () => {
    const cmd = b.dataset.gcmd;
    if (cmd === 'active') { gfxSetActive(G.handle); return; }   // active-window lamp
    if (cmd === 'zoomout') zoomAt(G, G.canvas.width / 2, G.canvas.height / 2, 1 / 1.25);
    if (cmd === 'fit') { setFitChecked(G, true); fitView(G); renderGraphics(G); }
    if (cmd === 'redraw') renderGraphics(G);
    if (cmd === 'histogram') {
      const p = $('.histogram-panel', el);
      if (!p) return;
      p.classList.toggle('hidden');
      if (!p.classList.contains('hidden')) drawHistogram(G);
    }
    if (cmd === 'profile') {
      const p = $('.profile-panel', el);
      if (p && !p.classList.contains('hidden')) {
        p.classList.add('hidden');
        G.profileLine = null;
        renderGraphics(G);
      }
      $$('.gt-btn[data-tool]', el).forEach(o => o.classList.remove('active'));
      const pb = $('.gt-btn[data-tool="profile"]', el);
      if (pb) pb.classList.add('active');
      G.tool = 'profile';
      G.canvas.classList.add('tool-profile');
      const hint = $('.gtools-hint', el);
      if (hint) hint.textContent = 'Drag a line in the image';
    }
    if (cmd === 'plot3d') show3DPlot();
    if (cmd === 'live') setLive(!liveTimer);
    if (cmd === 'metrology') {
      G.showMetrology = G.showMetrology === false;
      b.classList.toggle('active', G.showMetrology !== false);
      renderGraphics(G);
    }
  }));

  const metroBtn = $('.gt-btn[data-gcmd="metrology"]', el);
  if (metroBtn) metroBtn.classList.toggle('active', G.showMetrology !== false);

  $$('.gpanel-x', el).forEach(x => x.addEventListener('click', () => {
    const p = $('.' + x.dataset.close, el);
    if (p) p.classList.add('hidden');
    if (x.dataset.close === 'profile-panel') { G.profileLine = null; renderGraphics(G); }
    if (x.dataset.close === 'plot-panel') G.plotVar = null;
  }));

  const fitEl = $('.fit-check', el);
  fitEl?.addEventListener('change', () => { if (fitEl.checked) { fitView(G); renderGraphics(G); } });

  G.canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const r = G.canvas.getBoundingClientRect();
    zoomAt(G, e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  G.canvas.addEventListener('contextmenu', e => e.preventDefault());
  G.canvas.addEventListener('dblclick', () => { setFitChecked(G, true); fitView(G); renderGraphics(G); });
  G.canvas.addEventListener('pointerdown', e => gfxPointerDown(G, e));
  G.canvas.addEventListener('pointermove', e => gfxPointerMove(G, e));
  G.canvas.addEventListener('pointerup', e => gfxPointerUp(G, e));

  G.ro = new ResizeObserver(() => layoutGfx(G));
  G.ro.observe(G.wrap);
}

function gfxPointerDown(G, e) {
  const p = canvasToImage(G, e);
  if (G.tool === 'move') {
    G.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: G.view.ox, oy: G.view.oy };
    G.canvas.classList.add('dragging');
  } else if (G.tool === 'zoom') {
    G.drag = { kind: 'zoom', x0: p.cx, y0: p.cy, x1: p.cx, y1: p.cy, out: (e.button === 2 || e.altKey) };
  } else if (G.tool === 'profile') {
    G.drag = { kind: 'profile', x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  } else if (G.tool === 'select') {
    /* Feature Inspection: the click picks the region element / XLD contour it
       lands on and stays there (no drag) */
    const hit = featPickAt(G, p.x, p.y);
    if (hit) {
      setFeatureSelection(hit.name, hit.id, G.handle);
      log(`Feature Inspection: ${hit.name}[${hit.id}] (${hit.rec.type || hit.rec.kind}) picked in window ${G.handle}.`, 'msg');
    } else {
      log('Feature Inspection: no region or XLD contour under the cursor.', 'msg');
    }
  }
  G.canvas.setPointerCapture(e.pointerId);
}

function gfxPointerMove(G, e) {
  const p = canvasToImage(G, e);
  const gy = grayAt(G, p.x, p.y);
  const gEl = $('.gstatus-gray', G.el), pEl = $('.gstatus-pos', G.el);
  if (gEl) gEl.textContent = 'Gray: ' + (gy !== null && G.base ? gy : '—');
  if (pEl) pEl.textContent = (gy !== null && G.base) ? `Row: ${p.y | 0} Col: ${p.x | 0}` : 'Row: — Col: —';
  if (!G.drag) return;
  if (G.drag.kind === 'pan') {
    G.view.ox = G.drag.ox + (e.clientX - G.drag.sx);
    G.view.oy = G.drag.oy + (e.clientY - G.drag.sy);
    setFitChecked(G, false);
    renderGraphics(G);
  } else if (G.drag.kind === 'profile') {
    G.drag.x2 = p.x; G.drag.y2 = p.y;
    G.profileLine = { ...G.drag };
    renderGraphics(G);
  } else if (G.drag.kind === 'zoom') {
    G.drag.x1 = p.cx; G.drag.y1 = p.cy;
    renderGraphics(G);
  }
}

function gfxPointerUp(G, e) {
  if (G.drag && G.drag.kind === 'profile' &&
      Math.hypot(G.drag.x2 - G.drag.x1, G.drag.y2 - G.drag.y1) > 4) {
    const p = $('.profile-panel', G.el);
    if (p) p.classList.remove('hidden');
    drawProfile(G);
  }
  if (G.drag && G.drag.kind === 'zoom') {
    const w = Math.abs(G.drag.x1 - G.drag.x0), h = Math.abs(G.drag.y1 - G.drag.y0);
    if (w > 6 && h > 6) {
      applyZoomRect(G, Math.min(G.drag.x0, G.drag.x1), Math.min(G.drag.y0, G.drag.y1), w, h);
    } else {
      zoomAt(G, G.drag.x0, G.drag.y0, G.drag.out ? 1 / 1.25 : 1.25);
    }
  }
  G.drag = null;
  G.canvas.classList.remove('dragging');
}

wireGfxWindow(mainGfx);

/* ==========================================================================
   EXECUTION ENGINE
   ========================================================================== */
function setStatus(msg, running) {
  const el = $('#status-msg');
  el.textContent = msg;
  el.classList.toggle('running', !!running);
}

/* ==========================================================================
   OPENCV WASM RUNTIME + OPERATOR EXECUTION
   ========================================================================== */
let opencvReady = false;
function waitOpenCV() {
  return new Promise(res => {
    const t0 = performance.now();
    (function poll() {
      if (typeof cv !== 'undefined' && cv.Mat) {
        opencvReady = true;
        $('#status-build').textContent = 'OpenCVS · OpenCV WASM';
        if (!$('#status-msg').classList.contains('running')) setStatus('Ready');
        res(true);
      } else if (performance.now() - t0 > 60000) {
        log('OpenCV WASM failed to load — operators unavailable.', 'err');
        res(false);
      } else setTimeout(poll, 1000);
    })();
  });
}

/* An iconic record is NOT owned by a single name: a procedure parameter
   aliases the caller's variable (`find_center (Image, …)` binds the parameter
   name to the same record) and the parameter name stays in the workspace, so
   one record can be reachable under several names.  Replacing or overwriting
   one of those names must therefore release the cv.Mat only when the LAST name
   that refers to the record goes away — disposing it earlier leaves a deleted
   Mat in the workspace and the next syncUI()/thumbnail would touch freed data
   ("cannot call emscripten binding method Mat.rows getter on deleted object").
   `exceptName` is the name that is being overwritten (it may still be listed
   under the new record when this is called after the workspace was updated). */
function releaseRecord(rec, exceptName) {
  if (!rec || typeof rec.dispose !== 'function') return;
  let shared = false;
  state.iconic.forEach((r, n) => { if (r === rec && n !== exceptName) shared = true; });
  if (!shared) rec.dispose();
}

/* put `rec` into the workspace under `name` (operator result, procedure
   parameter, bound output) and release the object the name held before */
function bindRecord(name, rec) {
  const old = state.iconic.get(name);
  state.iconic.set(name, rec);
  if (old && old !== rec) releaseRecord(old, name);
}

function makeOpCtx() {
  const touched = [];                          // iconic results of this operator call
  return {
    /* Fetch an iconic input. An undefined variable is a program error (HALCON
       aborts with "variable is not initialized"), so raise a readable message
       instead of letting the operator fail on a property of undefined. */
    iconic: name => {
      const key = String(name === undefined || name === null ? '' : name).trim();
      if (!key) throw new Error('no iconic object given');
      const rec = state.iconic.get(key);
      if (!rec) throw new Error(`iconic object '${key}' is not defined`);
      return rec;
    },
    defIconic(name, rec) {
      bindRecord(name, rec);                       // frees the previous cv.Mat (e.g. grab loops)
      if (state.selectedVar === null) state.selectedVar = name;
      touched.push(name);
    },
    defCtrl(name, value, type) { state.ctrl.set(name, { value, type }); },
    ctrl(name) { const v = state.ctrl.get(name); return v ? v.value : undefined; },
    displayImage(name, fit) { gfxShowImage(gfxActive(), name, fit); },
    displayOverlay(name) { gfxShowItem(gfxActive(), name); },
    /* display an object in a specific window (disp_obj / disp_region /
       disp_image); handle undefined = the active window */
    displayObject(name, handle) {
      const G = handle === undefined ? gfxActive() : GFX.wins.get(handle);
      if (!G) throw new Error(`invalid window handle ${handle}`);
      const rec = state.iconic.get(name);
      if (!rec) throw new Error(`iconic object '${name}' is not defined`);
      if (rec.kind === 'image') gfxShowImage(G, name); else gfxShowItem(G, name);
    },
    setMetrologyOverlay(canvas) { const G = gfxActive(); G.metrology = canvas; renderGraphics(G); },
    setMessage(t, handle, props) {
      const G = (handle !== undefined && GFX.wins.has(handle)) ? GFX.wins.get(handle) : gfxActive();
      gfxShowMessage(G, t, props);
    },
    /* disp_* primitives: handle undefined = the active window (HALCON accepts
       the empty handle / 0 for it) */
    dispPrimitive(handle, prim) {
      const G = handle === undefined ? gfxActive() : GFX.wins.get(handle);
      if (!G) throw new Error(`invalid window handle ${handle}`);
      gfxShowPrimitive(G, prim);
    },
    /* size of the current image (base image of the active window, else the
       first image variable, else the workspace default): region and XLD
       generators use it so they line up with the image they describe */
    imgSize() {
      const base = gfxActive().base && state.iconic.get(gfxActive().base);
      if (base && base.mat) return { W: base.mat.cols, H: base.mat.rows };
      for (const rec of state.iconic.values()) {
        if (rec.kind === 'image' && rec.mat) return { W: rec.mat.cols, H: rec.mat.rows };
      }
      return { W: IMG_W, H: IMG_H };
    },
    setDisplayParams(patch) { gfxSetParams(gfxActive(), patch); },
    setPart(r1, c1, r2, c2) { gfxSetPart(gfxActive(), r1, c1, r2, c2); },
    setUpdateWindow(on) { state.updateWindow = !!on; },
    openWindow(opts) { return gfxOpen(opts); },
    closeWindow(handle) { gfxClose(handle); },
    clearWindow() { const G = gfxActive(); G.base = null; G.items = []; G.metrology = null; renderGraphics(G); },
    setActiveWindow(handle) { gfxSetActive(handle); },
    getActiveWindow() { return gfxActive().handle; },
    /* dev_update_window('on'): the iconic results of an operator are displayed
       automatically in the active window — like HDevelop, where every operator
       whose iconic output is not suppressed updates the graphics window. */
    autoDisplayResults() {
      if (!touched.length) return;
      const G = gfxActive();
      for (const nm of touched.splice(0)) {
        const rec = state.iconic.get(nm);
        if (!rec) continue;
        try { gfxShowItem(G, nm); } catch (e) { /* window not displayable */ }
      }
    },
    log,
    syntheticImage: () => syntheticCanvas,
  };
}

/* The processor hit a line it cannot run. It never continues past such a line
   (that would quietly produce wrong results) and it never gives up silently:
   the failure goes to the Errors tab, the line is marked in the program window
   and a message box names the procedure, the line number and the source line.
   `op` is the operator that failed, or null when the line itself is malformed. */
function haltLine(proc, n, text, op, reason) {
  state.errorLine = { proc, line: n, text };
  state.pc = null;                                   // the processor stopped here for good
  if (proc !== state.proc && PROCEDURES[proc]) {      // show the procedure that failed
    state.proc = proc;
    $('#proc-select').value = proc;
    $('#status-proc').textContent = `Procedure: ${proc}`;
    state.cursor = n;
    editorLoad();
  }
  state.errors.push({
    t: now(),
    text: `${op ? `${op}: ` : ''}${reason} (${proc}, line ${n})`,
  });
  log(`${op ? `${op}: ` : ''}${reason} — ${proc}, line ${n}. Execution stopped here.`, 'err');
  if (typeof showModal !== 'function') return;
  showModal('Invalid program line',
    `<p><b>${esc(op || 'Invalid line')}</b> — ${esc(reason)}</p>` +
    `<p class="dim">Procedure <code>${esc(proc)}</code>, line <b>${n}</b> — ` +
    `the processor stopped here.</p>` +
    `<pre class="errline">${esc(String(text === undefined ? '' : text).trim())}</pre>`);
  const ok = $('#modal-ok');                   // the OK button jumps to the line
  if (!ok) return;
  ok.textContent = 'Go to line';
  ok.onclick = () => { closeModal(); edFocusLine(n); };
}

/* ==========================================================================
   STRUCTURED STATEMENTS and USER PROCEDURES
   The program counter walks the executable lines of the current procedure;
   for/while/if blocks and procedure calls move it explicitly through
   state.nextPc.  state.loops holds the loop blocks that are currently open in
   the running procedure, state.branches remembers which if a branch was
   already taken in, state.frames is the stack of pending procedure calls.
   ========================================================================== */
const LOOP_LIMIT = 2000000;              // runaway guard: the browser stays usable

function setCtrlNum(name, v) {
  state.ctrl.set(name, { value: String(v), type: Number.isInteger(v) ? 'integer' : 'real' });
  if (state.selectedCtrl === null) state.selectedCtrl = name;
}

/* Advance the program counter after line n of proc was executed. */
function advancePc(proc, n) {
  let nxt = state.nextPc === undefined ? nextExecutable(proc, n) : state.nextPc;
  state.nextPc = undefined;
  /* a procedure that runs off its last line returns to its caller */
  while (nxt === null && state.frames.length) nxt = implicitReturn();
  return nxt;
}

/* Keep the Program Window on the procedure the program counter is in.  A call
   enters a procedure (and its return leaves it) without the window noticing, so
   the editor went on showing the caller's text while state.pc was a line number
   of the callee: the arrow of the counter was drawn on whatever lines of the
   *caller* had that number, and a step into 'find_center' looked like line 1 of
   'main' starting over.
   The running line is followed even while the window already shows the current
   procedure, so a step to a line below the visible area scrolls it into view
   instead of leaving the marker off screen.  Focus is not taken: the shortcuts
   are handled on the document (see the keyboard section), and a long F5 run must
   not pull the focus away from whatever window the user is working in. */
function showRunningProcedure() {
  const sel = $('#proc-select');
  if (sel && sel.value !== state.proc) {           // a call/return changed procedure
    sel.value = state.proc;
    const sp = $('#status-proc');
    if (sp) sp.textContent = `Procedure: ${state.proc}`;
    editorLoad();                                  // the callee's own text
  }
  if (state.pc !== null) edFocusLine(state.pc, false);   // caret on the running line
}

/* Alt+Enter and the Procedure box let the Program Window browse a procedure
   other than the one the counter is suspended in.  Continuing must run the line
   the counter sits on — not a same-numbered line of whatever procedure is on
   screen — so every "continue" returns the window to the counter's procedure
   first.  Returns true when it had to move. */
function backToCounterProcedure() {
  if (state.pc === null || state.pcProc === state.proc) return false;
  if (!state.pcProc || !PROCEDURES[state.pcProc]) return false;
  state.proc = state.pcProc;
  return true;
}

function implicitReturn() {
  const fr = state.frames.pop();
  addCallTime(fr);
  bindOutputs(fr);
  state.proc = fr.proc;
  log(`End of procedure reached — returned from ${fr.name}.`);
  return fr.next;
}

/* the output parameters of a call write into the caller's variables */
function bindOutputs(fr) {
  for (const o of fr.outputs) {
    const ic = state.iconic.get(o.param);
    if (ic) {
      bindRecord(o.target, ic);                 // drop the previous object of the target
      continue;
    }
    const c = state.ctrl.get(o.param);
    if (c) state.ctrl.set(o.target, c);
  }
}

/* the open loop block that starts at line n, or ends at line n, in proc */
function loopStartAt(proc, n) {
  for (let k = state.loops.length - 1; k >= 0; k--) {
    const f = state.loops[k];
    if (f.proc === proc && f.line === n) return f;
  }
  return null;
}
function loopEndingAt(proc, n) {
  for (let k = state.loops.length - 1; k >= 0; k--) {
    const f = state.loops[k];
    if (f.proc === proc && f.end === n) return f;
  }
  return null;
}
function loopTop(proc) {
  for (let k = state.loops.length - 1; k >= 0; k--) if (state.loops[k].proc === proc) return state.loops[k];
  return null;
}

/* new loop block; null when the closing keyword is missing */
function loopOpen(proc, n, kind) {
  const end = findBlockEdge(proc, n, null);
  return end === null ? null : { proc, line: n, end, kind, iters: 0 };
}

/* one more round of a loop: false = keep going, true = the guard tripped */
function loopStep(f) {
  if (++f.iters <= LOOP_LIMIT) return false;
  haltLine(f.proc, f.line, lineText(f.proc, f.line), null,
    `the ${f.kind} loop ran ${LOOP_LIMIT} times without finishing — execution stopped`);
  return true;
}

/* for <variable> := <start> to <end> [by <step>] … endfor */
function loopFor(proc, n) {
  const text = lineText(proc, n);
  let rest = text.replace(/^\s*for\s+/i, '');
  let stepSrc = null;
  const byM = /\s+by\s+(.+)$/i.exec(rest);
  if (byM) { stepSrc = byM[1].trim(); rest = rest.slice(0, byM.index); }
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([\s\S]+?)\s+to\s+([\s\S]+)$/i.exec(rest);
  if (!m) {
    haltLine(proc, n, text, null, "expected 'for <variable> := <start> to <end> [by <step>]'");
    return false;
  }
  const name = m[1];
  let f = loopStartAt(proc, n);
  if (f && f.kind === 'for') {                       // back from endfor: next round
    if (loopStep(f)) return false;
    const next = f.value + f.step;
    if (f.step > 0 ? next > f.to : next < f.to) {
      state.loops.pop();
      state.nextPc = f.end;                          // done: continue at endfor
      return true;
    }
    f.value = next;
  } else {
    let from, to, step;
    try {
      from = asNum(parseCtrlExpr(m[2]));
      to = asNum(parseCtrlExpr(m[3]));
      step = stepSrc === null ? 1 : asNum(parseCtrlExpr(stepSrc));
    } catch (err) {
      haltLine(proc, n, text, null, err.message || String(err));
      return false;
    }
    if (!step) { haltLine(proc, n, text, null, 'the loop step must not be 0'); return false; }
    f = loopOpen(proc, n, 'for');
    if (!f) { haltLine(proc, n, text, null, "the loop has no 'endfor'"); return false; }
    if (step > 0 ? from > to : from < to) {              // empty range: no round at all
      state.nextPc = f.end;
      return true;
    }
    f.var = name; f.step = step; f.value = from; f.to = to;
    state.loops.push(f);
    log(`for ${name} := ${from} to ${to}${step === 1 ? '' : ` by ${step}`}.`);
  }
  setCtrlNum(name, f.value);
  return true;
}

/* while (condition) … endwhile */
function loopWhile(proc, n, condSrc) {
  const text = lineText(proc, n);
  let f = loopStartAt(proc, n);
  if (!f || f.kind !== 'while') {
    f = loopOpen(proc, n, 'while');
    if (!f) { haltLine(proc, n, text, null, "the while loop has no 'endwhile'"); return false; }
    state.loops.push(f);
  } else if (loopStep(f)) return false;
  let ok;
  try {
    ok = truthy(parseCtrlExpr(condSrc));
  } catch (err) {
    haltLine(proc, n, text, null, `condition: ${err.message || err}`);
    return false;
  }
  log(`while: '${condSrc}' is ${ok ? 'true' : 'false'}.`);
  if (!ok) { state.loops.pop(); state.nextPc = f.end; }
  return true;
}

/* repeat … until (condition) */
function loopRepeat(proc, n) {
  const f = loopOpen(proc, n, 'repeat');
  if (!f) { haltLine(proc, n, lineText(proc, n), null, "the repeat loop has no 'until'"); return false; }
  state.loops.push(f);
  return true;
}

function loopUntil(proc, n, condSrc) {
  const f = loopEndingAt(proc, n);
  if (!f) return true;
  if (loopStep(f)) return false;
  let ok;
  try {
    ok = truthy(parseCtrlExpr(condSrc));
  } catch (err) {
    haltLine(proc, n, lineText(proc, n), null, `condition: ${err.message || err}`);
    return false;
  }
  if (ok) state.loops.pop(); else state.nextPc = f.line;
  return true;
}

/* endfor / endwhile: back to the head of the loop, which decides the next round */
function loopNext(proc, n) {
  const f = loopEndingAt(proc, n);
  if (!f) return true;
  if (loopStep(f)) return false;
  state.nextPc = f.line;
  return true;
}

function loopBreak(proc, n) {
  const f = loopTop(proc);
  if (!f) { haltLine(proc, n, lineText(proc, n), null, "'break' outside of a loop"); return false; }
  state.loops.pop();
  state.nextPc = f.end;
  return true;
}

function loopContinue(proc, n) {
  const f = loopTop(proc);
  if (!f) { haltLine(proc, n, lineText(proc, n), null, "'continue' outside of a loop"); return false; }
  state.nextPc = f.end;
  return true;
}

/* if (condition) … [elseif (condition) …] [else …] endif
   Blocks are keyed by their endif line: as long as a branch of a block has been
   taken, every later branch keyword of the same block jumps to its endif. */
function runIf(proc, n, condSrc) {
  const text = lineText(proc, n);
  const endif = findBlockEdge(proc, n, null);
  if (endif === null) { haltLine(proc, n, text, null, "the if statement has no 'endif'"); return false; }
  const key = `${proc}:${endif}`;
  if (state.branches.has(key)) { state.nextPc = endif; return true; }
  let ok;
  try {
    ok = truthy(parseCtrlExpr(condSrc));
  } catch (err) {
    haltLine(proc, n, text, null, `condition: ${err.message || err}`);
    return false;
  }
  log(`Condition '${condSrc}' is ${ok ? 'true' : 'false'}.`);
  if (ok) { state.branches.set(key, true); return true; }
  const edge = findBlockEdge(proc, n, true);
  state.nextPc = edge === null ? endif : edge;
  return true;
}

function branchElse(proc, n) {
  const endif = findBlockEdge(proc, n, null);
  if (endif === null) { haltLine(proc, n, lineText(proc, n), null, "the if statement has no 'endif'"); return false; }
  const key = `${proc}:${endif}`;
  if (state.branches.has(key)) { state.nextPc = endif; return true; }
  state.branches.set(key, true);
  return true;
}

/* statements the processor runs itself — the ones with an effect on the
   program counter, everything else is a no-op */
function runControlKeyword(proc, n, word, condSrc) {
  switch (word) {
    case 'for':      return loopFor(proc, n);
    case 'endfor':
    case 'endwhile': return loopNext(proc, n);
    case 'while':    return loopWhile(proc, n, condSrc);
    case 'repeat':   return loopRepeat(proc, n);
    case 'until':    return loopUntil(proc, n, condSrc);
    case 'if':
    case 'elseif':   return runIf(proc, n, condSrc);
    case 'else':     return branchElse(proc, n);
    case 'endif':    state.branches.delete(`${proc}:${n}`); return true;
    case 'break':    return loopBreak(proc, n);
    case 'continue': return loopContinue(proc, n);
    case 'return':   return procReturn(proc, n);
    case 'stop':
    case 'exit':     log('Program stopped (stop).'); return false;
    default:         return true;                 // global, comment, assert, …
  }
}

/* return from a procedure: the caller's variables receive the output
   parameters, the program counter continues after the call */
function procReturn(proc, n) {
  const fr = state.frames.pop();
  if (!fr) { log(`Returned from ${proc} — the program ends here.`); return false; }
  addCallTime(fr);                       // the call line carries the whole call
  bindOutputs(fr);
  state.proc = fr.proc;
  state.nextPc = fr.next;
  log(`Returned from ${proc}.`);
  return true;
}

/* User procedure call.  The interface of the procedure (its <interface> in a
   .hdev file) binds the arguments: input parameters are copied into the
   procedure, output parameters are written back into the caller's variables,
   `_` discards an argument, exactly like in HDevelop. */
function callProcedure(name, args, callerProc, callerLine) {
  const P = PROCEDURES[name];
  const params = Array.isArray(P.params) ? P.params : null;
  const frame = { name, proc: callerProc, line: callerLine, tAcc: timeSum,
                  next: nextExecutable(callerProc, callerLine), outputs: [] };
  if (!params) {
    log(`${name}: the procedure declares no interface — its arguments are not bound.`, 'warn');
  } else if (params.length !== args.length) {
    haltLine(callerProc, callerLine, lineText(callerProc, callerLine), name,
      `expects ${params.length} parameter(s) (${params.map(p => p.name).join(', ')}), got ${args.length}`);
    return false;
  } else {
    for (let k = 0; k < params.length; k++) {
      const param = params[k];
      const arg = String(args[k] === undefined ? '' : args[k]).trim();
      if (arg === '_' || arg === '') continue;            // HDevelop: "do not pass this one"
      if (param.dir === 'out') { frame.outputs.push({ param: param.name, target: arg }); continue; }
      const ic = state.iconic.get(arg);
      if (ic) { bindRecord(param.name, ic); continue; }
      const c = state.ctrl.get(arg);
      if (c) { state.ctrl.set(param.name, c); continue; }
      /* an input parameter may be given as a literal or an expression as well
         ('f (Image, 128, Width/2, Out)') */
      if (param.type === 'ctrl') {
        try {
          const v = parseCtrlExpr(arg);
          state.ctrl.set(param.name, { value: ctrlText(v), type: ctrlType(v) });
          continue;
        } catch (err) { /* not an expression: report the missing variable below */ }
      }
      haltLine(callerProc, callerLine, lineText(callerProc, callerLine), name,
        `input parameter '${param.name}' uses '${arg}', which is not defined`);
      return false;
    }
  }
  const first = firstExecutable(name);
  if (first === null) {
    haltLine(callerProc, callerLine, lineText(callerProc, callerLine), name, 'the procedure is empty');
    return false;
  }
  state.frames.push(frame);
  state.proc = name;
  state.nextPc = first;
  log(`Calling ${name} (${params ? params.map(p => p.name).join(', ') : `${args.length} argument(s)`}).`);
  return true;
}

/* ---------------- execution times (the gutter shows them, like HDevelop) ---------
   Every executed line collects the wall time it spent on the OpenCV work — not
   the UI refresh that follows the line, which is far more expensive than e.g.
   `count_obj` and would report a 0.1 ms operator as a 20 ms line.  The times add
   up over the whole run, so a line inside a loop shows the total of its
   iterations, which is what makes a profile readable — but it is also easy to
   take that total for one execution (a loop body's 1.43 s is 8 × 179 ms, and
   the line then looks eight times slower than it is), so a total that covers
   more than one execution is marked `×n`.
   They describe the *last* execution: a fresh run starts from an empty table,
   and a line whose text has changed since it ran keeps no time (the statement
   moved).  A procedure call is one line for the interpreter — the callee runs
   inside it — so the call line in the caller carries the whole call, while the
   lines of the callee carry their own times.
   The time of a line is the cost of the statement.  With dev_update_on () the
   automatic display of the result happens inside the same step, and painting a
   19.5 M pixel frame costs more than most operators do (the RGBA canvas of a
   region is ~50 ms, that of an image ~45 ms) — charging that to the operator
   would report a `dyn_threshold` that computes in 32 ms as a 90 ms line.  The
   display time is therefore recorded separately and shown as a dim `+58d`
   behind the time (see fmtDisp below). */
const TIMES_W = 64;                    // width of the time column (px)
const TIMES_W_WIDE = 84;               // …and while a line shows its execution count
const TIMES_W_WIDEST = 116;            // …and while it shows the display time it paid
let monacoTimesWidth = 10;             // current lineDecorationsWidth of the VS Code editor
let monacoTimesHost = null;            // the layer the times are drawn into
let timeSum = 0;                       // operator time recorded so far, for the call lines
let dispSum = 0;                       // display time recorded so far, for the run summary
let logBase = 0;                       // logCost when the current line started

/* A line is timed from just after its history entry to just before the window
   refresh that follows it; the entries the line itself writes (a call's
   "Calling …") are subtracted as well.  Both are bookkeeping: a single history
   entry costs several milliseconds here and would report a 0.05 ms operator as
   an 8 ms line. */
function timeStart() {
  logBase = logCost;
  return performance.now();
}
function timeEnd(t0) {
  return Math.max(0, performance.now() - t0 - (logCost - logBase));
}

function clearTimes() {
  state.times.clear();
  timeSum = 0;
  dispSum = 0;
  setTimesColumn(false);
}

/* the time of line n, only when that line still holds the statement that ran */
function lineTime(proc, n) {
  const arr = state.times.get(proc);
  const t = arr && arr[n - 1];
  return t && t.text === lineText(proc, n) ? t.ms : null;
}

/* the display time line n paid on top of its own time (0 when it displays
   nothing, which is every line of a program run with dev_update_off ()) */
function lineDisp(proc, n) {
  const arr = state.times.get(proc);
  const t = arr && arr[n - 1];
  return t && t.text === lineText(proc, n) ? (t.d || 0) : 0;
}

/* How many executions the time of line n covers (0 = the line did not run):
   a loop body or a procedure called several times adds its iterations up. */
function lineCount(proc, n) {
  const arr = state.times.get(proc);
  const t = arr && arr[n - 1];
  return t && t.text === lineText(proc, n) ? (t.n || 1) : 0;
}

function addLineTime(proc, n, ms, count = true, disp = 0) {
  const text = lineText(proc, n);
  let arr = state.times.get(proc);
  if (!arr) { arr = []; state.times.set(proc, arr); }
  const t = arr[n - 1];
  /* `count` is false for the time a returning call hands to its call line:
     that is the same execution's second record, not a new one — counting it
     would mark every `find_center (…)` call line with a false `×2`.
     `disp` is the display the line caused, kept apart from `ms` (see the note
     above the times column) and accumulated too, so the two suffixes match. */
  arr[n - 1] = (t && t.text === text)
    ? { text, ms: t.ms + ms, n: (t.n || 1) + (count ? 1 : 0), d: (t.d || 0) + disp }
    : { text, ms, n: count ? 1 : 0, d: disp };
  timeSum += ms;
  dispSum += disp;
}

/* A returning call hands its call line what its lines recorded while the frame
   was open — exactly their sum, nested calls included.  Reading the clock
   instead would count the history entry and the window refresh that each of
   those lines caused, which the lines themselves do not report. */
function addCallTime(fr) {
  if (fr && fr.tAcc !== undefined) addLineTime(fr.proc, fr.line, timeSum - fr.tAcc, false);
}

function fmtTime(ms) {
  if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s';
  if (ms >= 100) return Math.round(ms) + ' ms';
  if (ms >= 10) return ms.toFixed(1) + ' ms';
  if (ms < 0.05) return '<0.1 ms';         // the clock itself only resolves 0.1 ms
  return ms.toFixed(2) + ' ms';
}

/* the display time of a line as the dim marker the gutter shows: `+58d` is
   'here 58 ms of the line were the graphics window, not the operator', and a
   run that paints more than 10 s of them says `+12.3 sd` */
function fmtDisp(ms) {
  return ms >= 10000 ? `+${(ms / 1000).toFixed(1)}sd` : `+${Math.round(ms)}d`;
}

function linesWithTimes() {
  const L = linesOf(state.proc);
  return L.some((_, i) => lineTime(state.proc, i + 1) !== null);
}

/* The column lives in the band between the line numbers and the code — Monaco's
   "line decorations" gutter, free here because this build has no folding.  The
   band is widened only while there is something to show, so the code does not
   move for a program that never ran. */
function setTimesColumn(on, wide = 0) {
  /* wide: 0 = plain time, 1 = the line also shows its execution count,
     2 = it also shows the display time it paid */
  const w = !on ? 10 : wide >= 2 ? TIMES_W_WIDEST : wide === 1 ? TIMES_W_WIDE : TIMES_W;
  if (w === monacoTimesWidth) return;
  monacoTimesWidth = w;
  if (monacoEditor) monacoEditor.updateOptions({ lineDecorationsWidth: w });
}

function monacoRenderTimes() {
  if (!monacoEditor) return;
  const show = state.showTimes && linesWithTimes();
  const L0 = linesOf(state.proc);
  const hasDisp = show && L0.some((_, i) => lineDisp(state.proc, i + 1) >= 1);
  const hasCount = show && L0.some((_, i) => lineCount(state.proc, i + 1) > 1);
  setTimesColumn(show, hasDisp ? 2 : hasCount ? 1 : 0);
  if (!monacoTimesHost) {
    monacoTimesHost = document.createElement('div');
    monacoTimesHost.id = 'editor-times';
    $('#editor-monaco').appendChild(monacoTimesHost);
  }
  if (!show) {
    if (monacoTimesHost.firstChild) monacoTimesHost.textContent = '';
    return;
  }
  const L = linesOf(state.proc);
  const li = monacoEditor.getLayoutInfo();
  const x = (li.glyphMarginLeft || 0) + li.glyphMarginWidth + li.lineNumbersWidth;
  const w = Math.max(0, li.contentLeft - x);
  const lh = monacoEditor.getOption(monaco.editor.EditorOption.lineHeight);
  const top = monacoEditor.getScrollTop();       // the layer does not scroll itself
  let html = '';
  for (let i = 0; i < L.length; i++) {
    const ms = lineTime(state.proc, i + 1);
    if (ms === null) continue;
    const n = lineCount(state.proc, i + 1);
    const d = lineDisp(state.proc, i + 1);
    const y = monacoEditor.getTopForLineNumber(i + 1) - top;
    const cnt = n > 1 ? `<span class="ltime-n">×${n}</span>` : '';
    const dsp = d >= 1 ? `<span class="ltime-d">${fmtDisp(d)}</span>` : '';
    const tip = `operator${n > 1 ? ` × ${n}` : ''}: ${fmtTime(ms)}` +
      (d >= 0.05 ? `, display: ${fmtTime(d)} (dev_update_on ())` : '');
    html += `<div class="ltime" title="${tip}" style="top:${y}px;left:${x}px;width:${w}px;` +
      `height:${lh}px;line-height:${lh}px">${fmtTime(ms)}${cnt}${dsp}</div>`;
  }
  monacoTimesHost.innerHTML = html;
}

/* the times toggle lives in two places — the Visualization menu and the
   toolbar button — and both must show the same state */
function syncTimesButtons() {
  $('#menu-times')?.classList.toggle('checked', state.showTimes);
  const tb = $('#tb-times');
  if (tb) {
    tb.classList.toggle('on', state.showTimes);
    tb.setAttribute('aria-pressed', String(state.showTimes));
  }
}

function setShowTimes(on) {              // Visualization ▸ Execution Times / toolbar
  state.showTimes = !!on;
  syncTimesButtons();
  renderProgram();
  scheduleSave();
}

async function execute(proc, n) {        // execute line n of proc; false = stop
  let t0 = timeStart();
  const text = lineText(proc, n);

  /* assignment: Name := expression */
  const asg = parseAssignment(text);
  if (asg) {
    log(text.trim(), 'cmd');
    t0 = timeStart();
    try {
      const v = parseCtrlExpr(asg.expr);
      state.ctrl.set(asg.name, { value: ctrlText(v), type: ctrlType(v) });
      if (state.selectedCtrl === null) state.selectedCtrl = asg.name;
    } catch (err) {
      haltLine(proc, n, text, null, err.message || String(err));
      syncUI();
      return false;
    }
    const dt = timeEnd(t0);
    syncUI();
    addLineTime(proc, n, dt);
    return true;
  }

  const p = parseLine(text);
  if (!p) {
    const problem = lineProblem(text);
    if (problem) {
      haltLine(proc, n, text, null, problem);       // invalid line: report and stop
      syncUI();
      return false;
    }
    if (!String(text).trim() || isComment(text)) return true;   // blank line / comment
    const condSrc = String(text).replace(/^\s*[A-Za-z_]+\s*/, '').replace(/^\(([\s\S]*)\)\s*$/, '$1');
    const cont = runControlKeyword(proc, n, lineWord(text), condSrc);
    const dt = timeEnd(t0);
    syncUI();
    addLineTime(proc, n, dt);
    return cont;
  }
  log(text.trim(), 'cmd');
  t0 = timeStart();

  let cont = true;
  let disp = 0;                        // the display this line pays for (see addLineTime)
  const impl = OP_IMPLS[p.op];
  if (impl) {
    if (!opencvReady && !(await waitOpenCV())) return false;
    const ctx = makeOpCtx();
    try {
      await impl(p.args, ctx);
      if (state.updateWindow) {                          // dev_update_window ('on')
        /* Timed apart from the operator: painting the result is window work,
           and on a 19.5 M pixel frame it is the larger half of the line. */
        const d0 = performance.now();
        ctx.autoDisplayResults();
        disp = performance.now() - d0;
      }
    } catch (err) {
      haltLine(proc, n, text, p.op, err && err.message ? err.message : String(err));
      cont = false;
    }
  } else if (p.op === 'if' || p.op === 'elseif') {
    cont = runIf(proc, n, p.args[0]);
  } else if (p.op === 'while') {
    cont = loopWhile(proc, n, p.args[0]);
  } else if (p.op === 'until') {
    cont = loopUntil(proc, n, p.args[0]);
  } else if (p.op === 'return') {
    cont = procReturn(proc, n);
  } else if (CONTROL_WORDS.has(p.op)) {
    cont = runControlKeyword(proc, n, p.op);
  } else if (PROCEDURES[p.op]) {
    cont = callProcedure(p.op, p.args, proc, n);
  } else {
    /* HDevelop refuses to run an operator it does not know; this build stops
       on it as well instead of skipping the line and going on. */
    state.unknownOps.add(p.op);
    haltLine(proc, n, text, p.op, 'not implemented in this build');
    cont = false;
  }
  const dt = timeEnd(t0);
  syncUI();
  addLineTime(proc, n, Math.max(0, dt - disp), true, disp);
  return cont;
}

function syncUI() {
  renderProgram();
  renderVariables();
  renderOperator();
  paintThumbs();
  renderWatch();
  GFX.wins.forEach(g => drawPlot(g));
  renderFeatureInspection();
  let bytes = 0;
  state.iconic.forEach(rec => {
    if (rec.mat) bytes += rec.mat.rows * rec.mat.cols;
    if (rec.labels) bytes += rec.labels.length * 4;
  });
  $('#status-mem').textContent = `Mem: ${Math.round(bytes / 1048576)} MB`;
}

/* F2 / a fresh run must not leave a live handle behind: iconic variables (their
   cv.Mat data is released by dispose()), control variables (window handles,
   metrology model handles, acquisition handles), the metrology models and
   their index counters, the spawned graphics windows with their handle
   numbers, and the camera streams opened by open_framegrabber. */
function clearRunState() {
  /* procedure parameters alias the caller's variables (one record for both
     names), so a record must be released exactly once */
  const freed = new Set();
  state.iconic.forEach(rec => {
    if (!rec || freed.has(rec)) return;
    freed.add(rec);
    if (rec.dispose) rec.dispose();
  });
  state.iconic.clear();
  state.ctrl.clear();
  state.selectedVar = null;
  state.selectedCtrl = null;
  state.unknownOps.clear();
  state.errorLine = null;                        // the red marker of the last failure
  state.nextPc = undefined;                      // pending program-counter jump
  state.loops.length = 0;                        // open for/while/repeat blocks
  state.frames.length = 0;                       // pending procedure calls
  state.branches.clear();                        // branches of the open if blocks
  if (typeof Metrology !== 'undefined') Metrology.disposeAll();
  if (typeof disposeGrabbers === 'function') disposeGrabbers();
  gfxCloseSpawned();                             // floating graphics windows
  GFX.seq = 1;                                   // window handles restart at 2
  mainGfx.base = null; mainGfx.items = []; mainGfx.metrology = null;
  mainGfx.part = null;
  mainGfx.params = Object.assign({}, DEV_PARAMS);
  mainGfx.profileLine = null;
  mainGfx.plotVar = null;
  mainGfx.drag = null;
}

/* the procedure a new execution starts in */
function entryProcName() { return PROCEDURES.main ? 'main' : Object.keys(PROCEDURES)[0]; }

/* A fresh execution always begins in the entry procedure.  A run that ended — or
   failed — inside a procedure leaves the counter there, and that procedure's
   input images are gone once the variables are cleared, so restarting where the
   last run stopped ran 'find_center' on a missing image.  The program window
   follows back to the entry procedure as well. */
function startNewRun() {
  const entry = entryProcName();
  if (entry) state.proc = entry;
  clearRunState();
  clearTimes();                          // the times describe the execution that starts here
  state.pc = firstExecutable(state.proc);
  showRunningProcedure();
}

function doReset() {
  state.running = false;
  state.stopRequested = false;
  setLive(false);
  prefetchCancel();                        // stop decoding images ahead of the program
  clearRunState();
  state.pc = null;
  const entry = entryProcName();               // reset goes back to the top
  if (entry) state.proc = entry;
  showRunningProcedure();
  syncUI();
  renderGraphics(mainGfx);
  log('Program reset.');
  setStatus('Ready');
}

async function doRun() {
  if (state.running || state.stepping) return;
  if (state.pc === null) startNewRun();
  else if (backToCounterProcedure()) showRunningProcedure();   // the window was browsing
  state.running = true; state.stopRequested = false;
  setStatus('Running…', true);
  while (state.pc !== null && state.running && !state.stopRequested) {
    const cur = state.proc, n = state.pc;
    renderProgram();
    const cont = await execute(cur, n);
    if (!cont) { state.pc = null; break; }
    if (state.stopRequested) break;
    state.pc = advancePc(cur, n);
    showRunningProcedure();
  }
  state.running = false;
  /* A program that runs with dev_update_on () pays for the graphics window in
     every line whose result is displayed.  The gutter shows the statements
     without it, so the sum no longer meets the clock — say what the difference
     is and how to get rid of it. */
  if (dispSum >= 50) {
    log(`Display: ${fmtTime(dispSum)} of the run went into the graphics window ` +
      `(dev_update_on ()).  The times in the gutter are the statements alone, ` +
      `and dev_update_off () skips this work.`, 'msg');
  }
  if (state.stopRequested) { log('Execution stopped by user.', 'warn'); setStatus('Stopped'); }
  else if (state.errorLine) { log(`Program aborted at line ${state.errorLine.line}.`, 'err'); setStatus(`Error at line ${state.errorLine.line}`); }
  else { log('Program stopped (stop).', 'msg'); setStatus('Ready'); }
  state.stopRequested = false;
  syncUI();
}

/* F6 (mode 'into') executes one line and follows a procedure call into the
   procedure; F8 (mode 'over') executes the whole call and stops on the next line
   of the caller, so a call line counts as a single step.  Both end with the
   program window showing the procedure the counter is in, and the status bar
   names it — "Stopped at main, line 6" is never ambiguous. */
async function doStep(mode = 'into') {
  /* One step at a time.  A held-down F6/F8 repeats the key while the previous
     step is still executing; two steps aimed at the same line execute it twice
     and corrupt the counter (a call frame entered twice, or an operator reading
     a variable the other step already released), so extra presses are ignored.
     The same flag keeps F5 out of a step in progress. */
  if (state.running || state.stepping) return;
  state.stepping = true;
  try { await stepOnce(mode); }
  finally { state.stepping = false; }
}

async function stepOnce(mode) {
  if (state.pc === null) {                     // first step of a sequence
    startNewRun();
    syncUI();
    return;
  }
  if (backToCounterProcedure()) showRunningProcedure();   // stepped a line of another procedure: back to the counter
  const cur = state.proc, n = state.pc;
  const depth = state.frames.length;          // pending calls before this line
  setStatus(`${mode === 'over' ? 'Step over' : 'Step'}: ${cur}, line ${n}`, true);
  let cont = await execute(cur, n);
  state.pc = cont ? advancePc(cur, n) : null;
  /* stepping over a call: run on without redrawing until the call's frame is
     gone (a return pops it) and the counter is back with its caller */
  while (cont && mode === 'over' && state.pc !== null && state.frames.length > depth) {
    const c2 = state.proc, n2 = state.pc;
    cont = await execute(c2, n2);
    state.pc = cont ? advancePc(c2, n2) : null;
  }
  showRunningProcedure();
  setStatus(state.errorLine ? `Error at ${state.errorLine.proc}, line ${state.errorLine.line}`
    : state.pc !== null ? `Stopped at ${state.proc}, line ${state.pc}` : 'Ready');
  syncUI();
}

async function doRunToCursor() {
  if (state.running || state.stepping) return;
  if (state.pc === null) startNewRun();
  else if (backToCounterProcedure()) showRunningProcedure();   // the window was browsing
  /* the caret line of the procedure on screen; right after a browse the window
     is back on the counter, so there is no other line to run to any more */
  const target = state.cursor;
  state.running = true; state.stopRequested = false;
  setStatus('Running to cursor…', true);
  while (state.pc !== null && state.pc !== target && !state.stopRequested) {
    const cur = state.proc, n = state.pc;
    renderProgram();
    if (!(await execute(cur, n))) { state.pc = null; break; }
    state.pc = advancePc(cur, n);
    showRunningProcedure();
  }
  state.running = false;
  setStatus(state.errorLine ? `Error at line ${state.errorLine.line}`
    : state.pc ? `Stopped at line ${state.pc}` : 'Ready');
  syncUI();
}

function doStop() {
  if (state.running) state.stopRequested = true;
  prefetchCancel();                        // the program is not going to read them now
}

/* ==========================================================================
   GRAPHICS TOOLS: profile / histogram / 3D plot
   ========================================================================== */
function drawHistogram(G) {
  const cv = $('.histogram-canvas', G.el);
  if (!cv) return;
  const x = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  x.fillStyle = '#0b0c0d'; x.fillRect(0, 0, w, h);
  const rec = currentImage(G);
  if (!rec) return;
  const bins = new Float32Array(256);
  const d = rec.gray;
  for (let p = 0; p < d.length; p++) bins[d[p]]++;
  const max = Math.max(...bins);
  x.fillStyle = '#4da3ff';
  const bw = w / 256;
  for (let i = 0; i < 256; i++) {
    const bh = (bins[i] / max) * (h - 14);
    x.fillRect(i * bw, h - bh, Math.ceil(bw), bh);
  }
  x.fillStyle = '#8a8f98'; x.font = '9px sans-serif';
  x.fillText('0', 2, 10); x.fillText('128', w / 2 - 8, 10); x.fillText('255', w - 20, 10);
  x.strokeStyle = '#ef5350';
  const tx = (128 / 255) * w;
  x.beginPath(); x.moveTo(tx, 12); x.lineTo(tx, h); x.stroke();
}

function drawProfile(G) {
  if (!G.profileLine) return;
  const cv = $('.profile-canvas', G.el);
  if (!cv) return;
  const x = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  x.fillStyle = '#0b0c0d'; x.fillRect(0, 0, w, h);
  const { x1, y1, x2, y2 } = G.profileLine;
  const len = Math.hypot(x2 - x1, y2 - y1) | 0 || 1;
  const vals = [];
  for (let i = 0; i <= len; i++) {
    const t = i / len;
    vals.push(grayAt(G, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t) || 0);
  }
  x.strokeStyle = '#2b2d31';
  for (let gy = 0; gy <= 4; gy++) { x.beginPath(); x.moveTo(0, gy * h / 4); x.lineTo(w, gy * h / 4); x.stroke(); }
  x.strokeStyle = '#ffd54f'; x.lineWidth = 1.4;
  x.beginPath();
  vals.forEach((v, i) => {
    const px = (i / vals.length) * w, py = h - (v / 255) * (h - 6) - 3;
    i ? x.lineTo(px, py) : x.moveTo(px, py);
  });
  x.stroke();
  x.fillStyle = '#8a8f98'; x.font = '9px sans-serif';
  x.fillText(`min ${Math.min(...vals)}  max ${Math.max(...vals)}  n ${vals.length}`, 4, 10);
}

/* plot a numeric control variable over its tuple index
   (dev_inspect_ctrl mode 'plot'); updates live while the panel is open */
function numericTuple(value) {
  if (typeof value === 'number') return [value];
  if (typeof value === 'string') {
    const m = value.match(/^\[(.*)\]$/);
    if (!m) return null;
    const parts = m[1].split(',').map(s => s.trim());
    if (!parts.length || parts.some(p => p === '' || isNaN(+p))) return null;
    return parts.map(Number);
  }
  return null;
}

function openPlot(name) {
  const rec = state.ctrl.get(name);
  const vals = rec && numericTuple(rec.value);
  if (!vals) {
    log(`Plot: '${name}' has no numeric values to plot.`, 'warn');
    return;
  }
  const G = gfxActive();
  G.plotVar = name;
  const p = $('.plot-panel', G.el);
  if (p) p.classList.remove('hidden');
  drawPlot(G);
  log(`Plot: '${name}' (${vals.length} values)`, 'msg');
}

function drawPlot(G) {
  if (!G || !G.plotVar) return;
  const cv = $('.plot-canvas', G.el);
  if (!cv) return;
  const panel = $('.plot-panel', G.el);
  if (!panel || panel.classList.contains('hidden')) return;
  const x = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  x.fillStyle = '#0b0c0d'; x.fillRect(0, 0, w, h);
  const rec = state.ctrl.get(G.plotVar);
  const vals = rec && numericTuple(rec.value);
  const titleEl = $('.plot-title-var', G.el);
  if (titleEl) titleEl.textContent = G.plotVar + (vals ? '' : ' (undefined)');
  if (!vals || !vals.length) return;
  const min = Math.min(...vals), max = Math.max(...vals);
  const px = i => vals.length === 1 ? w / 2 : 8 + (i / (vals.length - 1)) * (w - 16);
  const py = v => max === min ? h / 2 : h - 6 - ((v - min) / (max - min)) * (h - 18);
  x.strokeStyle = '#2b2d31';
  for (let gy = 0; gy <= 4; gy++) { x.beginPath(); x.moveTo(0, gy * h / 4); x.lineTo(w, gy * h / 4); x.stroke(); }
  x.strokeStyle = '#4da3ff'; x.lineWidth = 1.4;
  x.beginPath();
  vals.forEach((v, i) => i ? x.lineTo(px(i), py(v)) : x.moveTo(px(0), py(v)));
  x.stroke();
  x.fillStyle = '#ffd54f';
  vals.forEach((v, i) => { x.beginPath(); x.arc(px(i), py(v), 2, 0, 7); x.fill(); });
  x.fillStyle = '#8a8f98'; x.font = '9px sans-serif';
  x.fillText(`min ${min}  max ${max}  n ${vals.length}`, 4, 10);
}

function show3DPlot() {
  showModal('3D Plot',
    `<p>The 3D plot (intensity surface) is not available in the HTML demo.</p>
     <p class="dim">In OpenCVS this button opens an interactive 3D visualization
     of the displayed image (OpenGL-based "3D plot" window).</p>`);
}

/* ==========================================================================
   FEATURE INSPECTION WINDOW (Visualization ▸ Feature Inspection)
   --------------------------------------------------------------------------
   HDevelop's Feature Inspection: pick ONE region element or ONE XLD contour in
   a graphics window and read its shape, gray value and XLD features — the
   numbers the thresholds of select_shape / min_max_gray are chosen from.

   The measurements live in js/features.js (DOM-free, tools/test-features.js);
   here live the window, the select tool of the graphics windows and the
   highlight.  The gray value features are measured on the base image of the
   window the object was picked in, because a region has no gray values of its
   own.
   ========================================================================== */
const FI_IDS = { win: 'win-featureinsp', body: 'featinsp-body', where: 'featinsp-where',
                 status: 'featinsp-status', title: 'featinsp-title' };
/* the record kinds that hold regions: nothing else can be inspected */
const FI_REGION_KINDS = new Set(['region', 'regions', 'selected']);

const featInspWin = () => $('#' + FI_IDS.win);
function featInspVisible() { const w = featInspWin(); return !!w && winVisible(w); }

/* What is being inspected.  Without a pick the Variable Window's selection is
   inspected instead — HDevelop lets the variable list drive this window, and
   while stepping through a program that is the useful mode. */
function featTarget() {
  const f = state.featInsp;
  let name = f.name, id = f.id, handle = f.handle, picked = true;
  if (!name) {
    const sel = state.selectedVar;
    if (sel && state.iconic.has(sel)) { name = sel; id = 1; handle = null; picked = false; }
  }
  if (!name) return null;
  const rec = state.iconic.get(name) || null;
  const measurable = !!rec && (FI_REGION_KINDS.has(rec.kind) || rec.kind === 'xld');
  return { name, id: Math.max(1, id | 0), handle, picked, rec, measurable };
}

/* the gray plane a region is measured on: the base image of the graphics window
   the object was picked in */
function featPlane() {
  const G = GFX.wins.get(state.featInsp.handle) || gfxActive();
  const name = G && G.base;
  const rec = name ? state.iconic.get(name) : null;
  if (!rec) return null;
  const m = rec.mat;
  if (m && (!m.channels || m.channels() === 1)) return { gray: m.data, W: m.cols, H: m.rows, image: name };
  if (rec.gray && rec.gray.length) {
    const W = m ? m.cols : (rec.canvas ? rec.canvas.width : 0);
    const H = m ? m.rows : (rec.canvas ? rec.canvas.height : 0);
    if (W && H) return { gray: rec.gray, W, H, image: name };
  }
  return null;
}

/* Every feature of the current target, measured once per render.  Region
   elements are keyed by the id the value arrays of the record are indexed with
   — the label id of a label image, 1 for a mask region — which is what
   regionFeatures/labelBoxes fill in. */
function featMeasure() {
  const t = featTarget();
  const out = { group: 'region', vals: {}, note: '', count: 0, gray: null, id: 1 };
  if (!t || !t.rec || !t.measurable) return out;
  if (t.rec.kind === 'xld') {
    const conts = t.rec.xld || [];
    out.group = 'xld';
    out.count = conts.length;
    out.id = Math.min(t.id, Math.max(1, conts.length));
    out.vals = FeatureInspect.xldValues(conts[out.id - 1]) || {};
    out.note = `${conts.length} contour${conts.length === 1 ? '' : 's'}`;
    return out;
  }
  const regs = regionFeatures(t.rec);
  const boxes = labelBoxes(regs);
  const box = (boxes && boxes[t.id]) || null;
  const area = regs.areas ? regs.areas[t.id] : NaN;
  const cent = (regs.cents && regs.cents[t.id]) || null;
  out.count = regs.count || 1;
  out.id = t.id;
  for (const n of FeatureInspect.names('region')) {
    out.vals[n] = FeatureInspect.regionFeature(box, area, cent, n);
  }
  if (!box) out.note = 'no bounding box for this element';
  const plane = featPlane();
  const g = plane ? FeatureInspect.grayStats(plane, t.rec, t.id, box) : null;
  if (g) {
    out.vals.min = g.min; out.vals.max = g.max; out.vals.mean = g.mean; out.vals.deviation = g.deviation;
    out.gray = `${g.count}${g.step > 1 ? ` of ${Math.round(area)}` : ''} px`
      + (g.step > 1 ? ` (sampled 1/${g.step})` : '');
    out.plane = plane.image;
  }
  return out;
}

/* the features the window offers for the current target: regions have shape and
   gray value features, XLD contours only their own */
function featGroups(t) {
  if (t && t.rec && t.measurable) return t.rec.kind === 'xld' ? ['xld'] : ['region', 'gray'];
  return ['region', 'gray', 'xld'];
}

function renderFeatureInspection() {
  const body = $('#' + FI_IDS.body);
  if (!body) return;
  const f = state.featInsp, t = featTarget(), m = featMeasure();
  const off = !t || !t.measurable;
  const groups = featGroups(t);
  const label = t ? `${t.name}[${t.id}]` : '';

  const title = $('#' + FI_IDS.title), where = $('#' + FI_IDS.where), status = $('#' + FI_IDS.status);
  if (title) title.textContent = off ? 'Feature Inspection' : `Feature Inspection — ${label}`;
  if (where) where.textContent = off ? '–' : label;

  const tree = groups.map(gid => {
    const g = FeatureInspect.group(gid);
    return `<div class="fi-group" title="${esc(g.note)}">${esc(g.title)}</div>` + g.items.map(([name, op, desc]) =>
      `<label class="fi-item${off ? ' off' : ''}" title="${esc(op)} — ${esc(desc)}">` +
      `<input type="checkbox" data-feat="${name}"${f.checked.has(name) ? ' checked' : ''}${off ? ' disabled' : ''}>` +
      `<span>${esc(name)}</span></label>`).join('');
  }).join('');

  const rows = groups.map(gid => {
    const g = FeatureInspect.group(gid);
    const items = g.items.filter(it => f.checked.has(it[0]) && m.vals[it[0]] !== undefined);
    if (!items.length) return '';
    return `<div class="fi-group">${esc(g.title)}</div>` + items.map(([name, op, desc]) => {
      const v = m.vals[name];
      const rng = f.ranges.get(name) || FeatureInspect.defaultRange(name, v);
      const frac = FeatureInspect.gaugeFraction(v, rng[0], rng[1]);
      const outside = Number.isFinite(v) && (v < rng[0] || v > rng[1]);
      return `<div class="fi-row" title="${esc(op)} — ${esc(desc)}&#10;Double-click the bar to set its range">` +
        `<div class="fi-row-head"><span class="fi-name">${esc(name)}</span>` +
        `<span class="fi-val">${esc(FeatureInspect.format(v))}</span></div>` +
        `<div class="fi-gauge${outside ? ' off' : ''}" data-feat="${name}">` +
        `<div class="fi-fill" style="width:${(frac * 100).toFixed(1)}%"></div></div>` +
        (f.minMax ? `<div class="fi-scale"><span>${esc(FeatureInspect.format(rng[0]))}</span>` +
          `<span>${esc(FeatureInspect.format(rng[1]))}</span></div>` : '') +
        '</div>';
    }).join('');
  }).join('');

  const hint = !t
    ? '<div class="fi-hint"><b>Nothing inspected yet.</b><br>Click <b>Pick</b> and then a region element or an XLD contour in a graphics window &mdash; or select a variable in the Variable Window.</div>'
    : !t.rec
      ? `<div class="fi-hint">The variable <b>${esc(t.name)}</b> is undefined. Run the program to give it a value.</div>`
      : !t.measurable
        ? `<div class="fi-hint"><b>${esc(t.name)}</b> is a ${esc(String(t.rec.kind))}: only regions and XLD contours have features.</div>`
        : '<div class="fi-hint">Tick a feature on the left to measure it.</div>';
  body.innerHTML = `<div class="fi-tree">${tree}</div>` +
    `<div class="fi-values">${rows || hint}</div>`;

  if (status) {
    const parts = [];
    if (!off) {
      parts.push(`${label} — ${t.rec.type || t.rec.kind}`);
      parts.push(t.picked ? `picked in window ${state.featInsp.handle || 1}` : 'selected in the Variable Window');
      if (m.note) parts.push(m.note);
      if (m.gray) parts.push(`gray: ${m.gray}${m.plane ? ` on '${m.plane}'` : ''}`);
      else if (m.group === 'region') parts.push('no image behind the region — gray value features unavailable');
      if (m.count > 1) parts.push(`${m.count} elements`);
    } else parts.push('Nothing measured');
    status.textContent = parts.join(' · ');
  }
}

/* HDevelop's gauge context menu ("set range"): double-clicking a bar opens it.
   Min = Max goes back to the range the feature is shown with by default. */
function editFeatRange(name) {
  const f = state.featInsp, m = featMeasure();
  const rng = f.ranges.get(name) || FeatureInspect.defaultRange(name, m.vals[name]);
  showModal(`Range of '${name}'`, `
    <p class="dim">The gauge of <b>${esc(name)}</b> is drawn from <i>Min</i> to <i>Max</i>.
    The measured value is not affected &mdash; only the bar is scaled.</p>
    <p><label>Min <input id="fi-range-lo" type="number" step="any" value="${rng[0]}"></label>
    &nbsp; <label>Max <input id="fi-range-hi" type="number" step="any" value="${rng[1]}"></label></p>
    <p class="dim">Set Min = Max to use the default range again.</p>`);
  const ok = $('#modal-ok');
  ok.onclick = () => {
    const lo = Number($('#fi-range-lo').value), hi = Number($('#fi-range-hi').value);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) f.ranges.set(name, [lo, hi]);
    else f.ranges.delete(name);
    closeModal();
    renderFeatureInspection();
  };
}

function showFeatureInspection(on) {
  const w = featInspWin();
  if (!w) return;
  if (on) { if (!winVisible(w)) wmRestore(FI_IDS.win); }
  else w.classList.add('hidden-win');
  syncFeatMenu();
  updateSplitters();
  renderTaskbar();
  resizeGraphics();
}
function toggleFeatureInspection() { showFeatureInspection(!featInspVisible()); }

/* the Visualization ▸ Feature Inspection check follows its window */
function syncFeatMenu() {
  const w = featInspWin(), li = $('#menu-featinsp');
  if (w && li) li.classList.toggle('checked', winVisible(w));
}

/* ---------------- the select tool of the graphics windows ---------------- */

/* Which element of a record lies at an image point?  A mask region has exactly
   one element, a label region the label the pixel carries (if the record kept
   it — select_shape drops the others), an XLD record the contour whose points
   come closest to the cursor. */
function featHitId(rec, x, y, scale) {
  const r = Math.round(y), c = Math.round(x);
  if (rec.kind === 'xld') {
    const tol = Math.max(3, 6 / (scale || 1));
    let best = null, bestD = Infinity;
    (rec.xld || []).forEach((cont, k) => {
      for (let i = 0; i < cont.x.length; i++) {
        const d = Math.hypot(cont.x[i] - x, cont.y[i] - y);
        if (d < bestD) { bestD = d; best = k + 1; }
      }
    });
    return best !== null && bestD <= tol ? best : null;
  }
  const m = rec.mat;
  const W = rec.labels ? rec.w : (m ? m.cols : 0);
  const H = rec.labels ? rec.h : (m ? m.rows : 0);
  if (!W || !H || r < 0 || c < 0 || r >= H || c >= W) return null;
  if (rec.labels) {
    const id = rec.labels[r * W + c];
    if (!id) return null;
    if (rec.ids && rec.ids.length && !rec.ids.includes(id)) return null;
    return id;
  }
  if (m && m.data && m.data[r * W + c]) return 1;
  return null;
}

/* the topmost region / XLD contour under the cursor of a graphics window */
function featPickAt(G, x, y) {
  const names = [];
  if (G.base) names.push(G.base);
  for (const it of G.items) if (it.name && !it.msg && !it.prim) names.push(it.name);
  for (let i = names.length - 1; i >= 0; i--) {
    const rec = state.iconic.get(names[i]);
    if (!rec || !(FI_REGION_KINDS.has(rec.kind) || rec.kind === 'xld')) continue;
    const id = featHitId(rec, x, y, G.view.scale);
    if (id) return { name: names[i], id, rec };
  }
  return null;
}

function setFeatureSelection(name, id, handle) {
  const f = state.featInsp;
  f.name = name || null;
  f.id = Math.max(1, id | 0);
  f.handle = f.name ? (handle === undefined ? null : handle) : null;
  if (f.name) showFeatureInspection(true);
  else syncFeatMenu();
  renderFeatureInspection();
  GFX.wins.forEach(g => renderGraphics(g));     // the highlight follows the pick
}

/* the highlight is drawn in the window the object was picked in (the Variable
   Window adds no highlight: HDevelop marks what is displayed, not what is
   selected in a list) */
function featHighlight(G) {
  const f = state.featInsp;
  if (!f.name) return null;
  const t = featTarget();
  if (!t || !t.measurable) return null;
  if (f.handle && f.handle !== G.handle) return null;
  if (!(G.base === f.name || G.items.some(it => it.name === f.name && !it.msg))) return null;
  return t;
}

/* dashed box + centre mark around the inspected element, in image coordinates */
function drawFeatHighlight(g2, G, t) {
  const rec = t.rec, s = G.view.scale || 1;
  let box = null, cc = null;
  if (rec.kind === 'xld') {
    const conts = rec.xld || [];
    const v = FeatureInspect.xldValues(conts[Math.min(t.id, Math.max(1, conts.length)) - 1]);
    if (v) { box = [v.row1, v.column1, v.row2, v.column2]; cc = [v.column, v.row]; }
  } else {
    const regs = regionFeatures(rec);
    const boxes = labelBoxes(regs);
    box = (boxes && boxes[t.id]) || null;
    const cent = regs.cents && regs.cents[t.id];
    if (cent) cc = cent;
  }
  if (!box) return;
  g2.save();
  g2.strokeStyle = '#ff9f1a';
  g2.lineWidth = 1.5 / s;
  g2.setLineDash([5 / s, 3 / s]);
  g2.strokeRect(box[1], box[0], box[3] - box[1] + 1, box[2] - box[0] + 1);
  g2.setLineDash([]);
  if (cc) {
    g2.beginPath();
    g2.arc(cc[0], cc[1], 3 / s, 0, Math.PI * 2);
    g2.fillStyle = 'rgba(255,159,26,.85)';
    g2.fill();
  }
  g2.restore();
}

/* ---------------- the panel ---------------- */

/* Pick switches the ACTIVE graphics window to the select tool; the button shows
   the state of that window, so it also follows the graphics toolbar. */
function syncFeatPick() {
  const b = $('#fi-pick'), G = gfxActive();
  if (!b) return;
  b.classList.toggle('on', !!G && G.tool === 'select');
}

function wireFeatureInspection() {
  const body = $('#' + FI_IDS.body);
  if (!body) return;

  $('#fi-pick')?.addEventListener('click', () => {
    const G = gfxActive();
    if (!G) return;
    G.tool = G.tool === 'select' ? 'move' : 'select';
    G.canvas.classList.toggle('tool-select', G.tool === 'select');
    const hint = $('.gtools-hint', G.el);
    if (hint) hint.textContent = G.tool === 'select' ? 'Click a region or XLD contour to inspect it' : '';
    $$('.gt-btn[data-tool]', G.el).forEach(b => b.classList.toggle('active', b.dataset.tool === G.tool));
    syncFeatPick();
    log(G.tool === 'select'
      ? `Pick: click a region element or an XLD contour in window ${G.handle}.`
      : 'Pick off.', 'msg');
  });

  $('#fi-minmax')?.addEventListener('click', e => {
    const f = state.featInsp;
    f.minMax = !f.minMax;
    e.currentTarget.classList.toggle('on', f.minMax);
    renderFeatureInspection();
  });

  $('#fi-update')?.addEventListener('click', () => {
    renderFeatureInspection();
    GFX.wins.forEach(g => renderGraphics(g));
  });

  $('#fi-clear')?.addEventListener('click', () => {
    setFeatureSelection(null);
    log('Feature Inspection cleared.', 'msg');
  });

  /* the feature tree: ticking a feature adds its row and its gauge */
  body.addEventListener('change', e => {
    const cb = e.target.closest('input[data-feat]');
    if (!cb) return;
    const name = cb.dataset.feat, f = state.featInsp;
    if (cb.checked) f.checked.add(name); else f.checked.delete(name);
    renderFeatureInspection();
  });

  /* the gauges: a double click sets the range they are drawn with */
  body.addEventListener('dblclick', e => {
    const g = e.target.closest('.fi-gauge[data-feat]');
    if (g) editFeatRange(g.dataset.feat);
  });
}

/* ==========================================================================
   MODAL
   ========================================================================== */
function showModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal-overlay').classList.remove('hidden');
}
function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  const m = document.querySelector('#modal-overlay .modal');
  if (m) m.style.width = '';               // dialogs that widen themselves reset it
  $('#modal-ok').textContent = 'OK';       // error boxes borrow the button ("Go to line")
  $('#modal-ok').onclick = closeModal;
}

/* ==========================================================================
   UI WIRING
   ========================================================================== */
/* ---------------- menus ---------------- */
$$('.menu-title').forEach(btn => btn.addEventListener('click', e => {
  e.stopPropagation();
  const menu = btn.parentElement;
  const wasOpen = menu.classList.contains('open');
  $$('.menu.open').forEach(m => m.classList.remove('open'));
  if (!wasOpen) menu.classList.add('open');
}));
document.addEventListener('click', () => $$('.menu.open').forEach(m => m.classList.remove('open')));

const CMD = {
  run: doRun, runtocursor: doRunToCursor,
  step: () => doStep('into'), stepover: () => doStep('over'),
  stop: doStop, reset: doReset,
  new()  { newProgram(); },
  open() { openProgram(); },
  save() { saveProgram(); },
  saveas() { saveProgramAs(); },
  loadimg() { openImageFile(); },
  loadfolder() { openImageFolder(); },
  setdir() { setWorkingFolder(); },
  opensrv() { openProgramFromServer(); },
  quit() { log('Exit: close the browser tab to quit.', 'msg'); },
  about() {
    showModal('About OpenCVS',
      `<p><b>OpenCVisionStudio</b> (OpenCVS) &mdash; machine vision IDE</p>
       <p class="dim">HTML / JavaScript demo with a dark-mode UI. Simulates the
       classic vision-IDE windows: program, operator, variable, graphics and history,
       and executes a real (tiny) blob-analysis pipeline in the browser.</p>
       <p class="dim">Runs entirely in your browser.</p>`);
  },
  opdialog() { openOperatorDialog(); },
  times() { setShowTimes(!state.showTimes); },
  featinspect() { toggleFeatureInspection(); },
  resetlayout() { resetLayout(); },
  cascade() { wmCascade(); },
  tileh() { wmTile(true); },
  tilev() { wmTile(false); },
  dockall() { wmDockAll(); },
};

$$('.dropdown li[data-cmd]').forEach(li => li.addEventListener('click', () => {
  if (li.classList.contains('disabled')) return;
  CMD[li.dataset.cmd]?.();
}));
$$('.tb-btn[data-cmd]').forEach(btn => btn.addEventListener('click', () => CMD[btn.dataset.cmd]?.()));

function openOperatorDialog() {
  const names = Object.keys(OPINFO);
  showModal('Open Operator',
    `<div style="font-family:var(--font-mono);font-size:12px;max-height:220px;overflow:auto;border:1px solid var(--border-soft)">` +
    names.map((n, i) =>
      `<div class="opdlg-item" data-op="${n}" style="padding:3px 8px;cursor:pointer">${n}</div>`).join('') +
    `</div><p class="dim" id="opdlg-sig" style="margin-top:8px">Select an operator.</p>`);
  let chosen = null;
  $$('.opdlg-item').forEach(el => el.addEventListener('click', () => {
    $$('.opdlg-item').forEach(o => o.style.background = '');
    el.style.background = 'var(--sel)';
    chosen = el.dataset.op;
    $('#opdlg-sig').textContent = `${chosen} ( ${OPINFO[chosen].params.map(p => p[0]).join(', ')} )`;
  }));
  const ok = $('#modal-ok');
  ok.onclick = () => {
    closeModal();
    ok.onclick = closeModal;
    if (!chosen) return;
    const L = linesOf(state.proc);
    const idx = L.findIndex(t => new RegExp(`^\\s*${chosen}\\s*\\(`).test(t));
    if (idx >= 0) edFocusLine(idx + 1);
    state.opTab = 'parameters';
    $$('#operator-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'parameters'));
    syncUI();
    setStatus(`Operator: ${chosen}`);
  };
}
$('#modal-ok').onclick = closeModal;
$('#modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });

/* ==========================================================================
   WINDOW MANAGER (floating / drag / resize / taskbar / cascade / tile)
   ========================================================================== */
const WIN_IDS = { program: 'win-program', operator: 'win-operator', graphics: 'win-graphics', variable: 'win-variable', featureinsp: 'win-featureinsp', history: 'win-history' };
const WM = { z: 60, recs: {} };

const wmRow = () => $('#wm-row');
function wmRec(id) { return WM.recs[id] || (WM.recs[id] = { mode: 'docked' }); }

/* tabbed stacks (combined windows) */
const STACKS = new Map();   // stackId -> {id, el, members:[winId], active}
const STACK_OF = new Map(); // winId -> stackId
let stackSeq = 1;

const wmOwnerEl = winId => STACK_OF.has(winId) ? $('#' + STACK_OF.get(winId)) : $('#' + winId);
function stackVisible(s) {
  return !s.el.classList.contains('hidden-win') &&
         !s.el.classList.contains('minimized') &&
         !s.el.classList.contains('min');
}
function winVisible(win) {
  const sid = STACK_OF.get(win.id);
  if (sid) {
    const s = STACKS.get(sid);
    return stackVisible(s) && s.active === win.id;
  }
  return !win.classList.contains('hidden-win') &&
         !win.classList.contains('minimized') &&
         !win.classList.contains('min');
}
function wmRaise(win) { win.style.zIndex = ++WM.z; }

function wmRect(id) {
  const r = wmRow().getBoundingClientRect();
  const b = $('#' + id).getBoundingClientRect();
  return { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height };
}
function wmApplyRect(win, rc) {
  win.style.left = rc.x + 'px'; win.style.top = rc.y + 'px';
  win.style.width = rc.w + 'px'; win.style.height = rc.h + 'px';
}
function wmClearInline(win) {
  ['left', 'top', 'width', 'height'].forEach(p => win.style.removeProperty(p));
}

function wmFloat(id) {
  const win = $('#' + id), rec = wmRec(id);
  if (win.classList.contains('max')) {
    win.classList.remove('max');
    if (rec.maxRect) wmApplyRect(win, rec.maxRect);
  }
  win.classList.remove('min', 'minimized');
  win.classList.add('floating');
  wmApplyRect(win, rec.rect || wmRect(id));
  rec.mode = 'floating';
  wmRaise(win);
  updateSplitters();
  renderTaskbar();
}

function wmDock(id) {
  const win = $('#' + id), rec = wmRec(id);
  if (win.classList.contains('floating')) {
    if (win.classList.contains('max')) win.classList.remove('max');
    rec.rect = wmRect(id);
    win.classList.remove('floating', 'minimized');
    wmClearInline(win);
    if (win.classList.contains('window')) wmGoHome(win);
    rec.mode = 'docked';
    updateSplitters();
    resizeGraphics();
  }
  renderTaskbar();
}

function wmToggleFloat(id) {
  if (STACK_OF.has(id)) return;    // tabbed windows are managed by their stack
  wmRec(id).mode === 'floating' ? wmDock(id) : wmFloat(id);
}

function wmMinimize(id) {
  const owner = wmOwnerEl(id);
  if (wmRec(owner.id).mode === 'floating') owner.classList.add('minimized');
  else owner.classList.add('min');
  renderTaskbar();
}

function wmRestore(id) {
  const owner = wmOwnerEl(id);
  owner.classList.remove('hidden-win', 'min', 'minimized');
  const sid = STACK_OF.get(id);
  if (sid) wmSetActive(STACKS.get(sid), id);
  const key = Object.keys(WIN_IDS).find(k => WIN_IDS[k] === owner.id);
  if (key) $(`#menu-window-list li[data-win="${key}"]`)?.classList.add('checked');
  if (wmRec(owner.id).mode === 'floating') wmRaise(owner);
  renderTaskbar();
}

function wmTaskbarToggle(id) {
  const win = $('#' + id);
  if (!winVisible(win)) wmRestore(id);
  else wmMinimize(id);
}

function wmToggleMax(win) {
  const id = win.id, rec = wmRec(id);
  if (rec.mode === 'floating') {
    if (win.classList.contains('max')) {
      win.classList.remove('max');
      if (rec.maxRect) wmApplyRect(win, rec.maxRect);
    } else {
      rec.maxRect = wmRect(id);
      win.classList.add('max');
      wmClearInline(win);
      wmRaise(win);
    }
  } else {
    $$('.window.max').forEach(w => w.classList.remove('max'));
    win.classList.toggle('max');
  }
  renderTaskbar();
}

function wmWireGrip(el, grip) {
  grip.addEventListener('pointerdown', e => {
    if (el.classList.contains('max')) return;
    e.preventDefault(); e.stopPropagation();
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* no active pointer */ }
    const start = { x: e.clientX, y: e.clientY };
    const rc = wmRect(el.id);
    const move = ev => {
      el.style.width = Math.max(200, rc.w + ev.clientX - start.x) + 'px';
      el.style.height = Math.max(120, rc.h + ev.clientY - start.y) + 'px';
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      resizeGraphics();
      scheduleSave();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
}

function wmWire(win) {
  const id = win.id;
  const grip = document.createElement('div');
  grip.className = 'wm-grip';
  win.appendChild(grip);

  /* raise floating windows on click */
  win.addEventListener('pointerdown', () => {
    if (wmRec(id).mode === 'floating' && !win.classList.contains('max')) wmRaise(win);
  });

  /* drag by titlebar (with combine-drop onto other title bars) */
  $('.titlebar', win).addEventListener('pointerdown', e => startManagedDrag(win, id, e));

  /* resize via grip */
  wmWireGrip(win, grip);
}

/* ---------------- taskbar ---------------- */
function renderTaskbar() {
  const bar = $('#wm-taskbar');
  const gfxIds = [...GFX.wins.values()].filter(g => g.spawned).map(g => g.winId);
  const ids = [...Object.values(WIN_IDS), ...gfxIds];
  /* The Feature Inspection title bar names the object being inspected
     ("Feature Inspection — Regions[3]"), which is far too long for a taskbar
     button — its button keeps the plain window name. */
  const FIXED = { 'win-featureinsp': 'Feature Inspection' };
  bar.innerHTML = ids.map(id => {
    const win = $('#' + id);
    const vis = winVisible(win);
    const label = FIXED[id] || $('.title', win).textContent;
    return `<button class="wm-task-btn ${vis ? 'visible' : ''}" data-winid="${id}">` +
           `<span class="tb-icon win"></span><span class="wm-task-label">${label}</span></button>`;
  }).join('');
  $$('.wm-task-btn', bar).forEach(b =>
    b.addEventListener('click', () => wmTaskbarToggle(b.dataset.winid)));
  syncFeatMenu();          // Visualization ▸ Feature Inspection follows its window
  scheduleSave();
}

/* ---------------- window menu ---------------- */
$$('#menu-window-list li[data-win]').forEach(li => li.addEventListener('click', () => {
  const id = WIN_IDS[li.dataset.win];
  const win = $('#' + id);
  if (win.classList.contains('hidden-win')) {
    wmRestore(id);
  } else {
    win.classList.add('hidden-win');
    li.classList.remove('checked');
    renderTaskbar();
  }
}));

/* ---------------- per-window controls ---------------- */
$$('.window').forEach(win => {
  wmWire(win);
  $('.wbtn.min', win)?.addEventListener('click', () => wmMinimize(win.id));
  $('.wbtn.float', win)?.addEventListener('click', () => wmToggleFloat(win.id));
  $('.wbtn.max', win)?.addEventListener('click', () => wmToggleMax(win));
  $('.wbtn.close', win)?.addEventListener('click', () => {
    win.classList.add('hidden-win');
    const key = Object.keys(WIN_IDS).find(k => WIN_IDS[k] === win.id);
    $(`#menu-window-list li[data-win="${key}"]`)?.classList.remove('checked');
    log(`${$('.title', win).textContent} closed (reopen via Window menu or taskbar).`, 'msg');
    renderTaskbar();
  });
  /* Double-click on a title bar: a floating window maximises / restores.
     A docked window stays put — the editor sits directly under the Program
     Window's title bar, and a double click inside the editor must never tear
     the window out of the layout or blow it up to full size. */
  $('.titlebar', win).addEventListener('dblclick', e => {
    if (e.target.closest('.wbtn, .window-body, .gtoolbar, .gcanvas-wrap, .code, .pedit')) return;
    if (performance.now() - (wmRec(win.id).dragMoved || 0) < 250) return;
    if (wmRec(win.id).mode === 'floating') wmToggleMax(win);
  });
});

/* ---------------- arrange commands ---------------- */
function wmEntities() {
  return [...$$('#wm-row .window'), ...$$('#wm-row .wm-stack')]
    .filter(el => !STACK_OF.has(el.id) && !el.classList.contains('hidden-win') && !el.classList.contains('gfx-win'));
}

function wmCascade() {
  const row = wmRow().getBoundingClientRect();
  const ents = wmEntities();
  const W = Math.min(560, row.width * 0.62), H = Math.min(430, row.height * 0.7);
  ents.forEach((el, i) => {
    wmFloat(el.id);
    wmApplyRect(el, { x: 22 + i * 30, y: 14 + i * 26, w: W, h: H });
  });
  if (ents.length) log(`Cascaded ${ents.length} windows.`, 'msg');
  renderTaskbar();
}

function wmTile(horizontal) {
  const row = wmRow().getBoundingClientRect();
  const ents = wmEntities();
  const n = ents.length;
  if (!n) return;
  const s = Math.ceil(Math.sqrt(n));
  const cols = horizontal ? Math.ceil(n / s) : s;
  const rows = Math.ceil(n / cols);
  const tw = row.width / cols, th = row.height / rows;
  ents.forEach((el, i) => {
    const c = i % cols, r = (i / cols) | 0;
    wmFloat(el.id);
    wmApplyRect(el, { x: c * tw + 2, y: r * th + 2, w: tw - 4, h: th - 4 });
  });
  log(`Tiled ${n} windows ${horizontal ? 'horizontally' : 'vertically'}.`, 'msg');
  renderTaskbar();
}

function wmDockAll() {
  wmEntities().forEach(el => wmDock(el.id));
  log('All windows docked.', 'msg');
}

function resetLayout() {
  [...STACKS.values()].forEach(s => {
    s.members.forEach(m => $('#' + m).classList.remove('tabbed', 'inactive'));
    s.el.remove();
  });
  STACKS.clear();
  STACK_OF.clear();
  $$('.window:not(.gfx-win)').forEach(w => {
    w.classList.remove('hidden-win', 'min', 'max', 'minimized', 'floating');
    wmClearInline(w);
    w.style.removeProperty('z-index');
    WM.recs[w.id] = { mode: 'docked' };
    wmGoHome(w);
  });
  $$('#menu-window-list li[data-win]').forEach(li => li.classList.add('checked'));
  ['col-left', 'col-center', 'col-right'].forEach(id => { $('#' + id).style.flexBasis = ''; });
  /* a divider hands pixel sizes (and grow factors) to both of the windows it
     sits between while it is dragged, so every one of them is given back here */
  ['#win-program', '#win-operator', '#win-history', '#win-variable', '#' + FI_IDS.win]
    .forEach(s => {
      const w = $(s);
      w.style.flexBasis = '';
      w.style.flexGrow = '';
    });
  WM.z = 60;
  renderTaskbar();
  updateSplitters();
  resizeGraphics();
  log('Layout reset.', 'msg');
}

/* ==========================================================================
   LAYOUT PERSISTENCE (localStorage)
   ========================================================================== */
const LAYOUT_KEY = 'opencvs.layout.v1';

function saveLayout() {
  try {
    const wins = {};
    Object.values(WIN_IDS).forEach(id => {
      const w = $('#' + id);
      wins[id] = {
        mode: wmRec(id).mode,
        floatStyle: wmRec(id).mode === 'floating' ? {
          left: w.style.left, top: w.style.top,
          width: w.style.width, height: w.style.height,
          z: w.style.zIndex,
        } : null,
        max: w.classList.contains('max'),
        hidden: w.classList.contains('hidden-win'),
        min: w.classList.contains('min'),
        minimized: w.classList.contains('minimized'),
      };
    });
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({
      wins,
      stacks: [...STACKS.values()].map(s => {
        let n = s.el.nextElementSibling;
        while (n && s.members.includes(n.id)) n = n.nextElementSibling;
        return {
          members: s.members.slice(), active: s.active,
          mode: wmRec(s.id).mode,
          hidden: s.el.classList.contains('hidden-win'),
          min: s.el.classList.contains('min'),
          minimized: s.el.classList.contains('minimized'),
          max: s.el.classList.contains('max'),
          flex: s.el.style.flex, flexBasis: s.el.style.flexBasis,
          col: s.el.parentElement ? s.el.parentElement.id : '',
          beforeId: n ? n.id : null,
          rect: wmRec(s.id).mode === 'floating'
            ? { left: s.el.style.left, top: s.el.style.top, width: s.el.style.width, height: s.el.style.height }
            : null,
        };
      }),
      z: WM.z,
      cols: {
        left: $('#col-left').style.flexBasis,
        right: $('#col-right').style.flexBasis,
        program: $('#win-program').style.flexBasis,
        history: $('#win-history').style.flexBasis,
        /* the Variable / Feature Inspection split is a pair of bases, so both
           sides are stored to bring the divider back where it was left */
        variable: $('#win-variable').style.flexBasis,
        featureinsp: $('#' + FI_IDS.win).style.flexBasis,
      },
      breakpoints: [...state.breakpoints],
      proc: state.proc,
      showTimes: state.showTimes,
      tabs: { vars: state.varsTab, op: state.opTab, hist: state.histTab },
      program: Object.fromEntries(Object.entries(PROCEDURES).map(([k, v]) => [k, v.lines.slice()])),
    }));
  } catch (e) { /* storage unavailable */ }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  pushProgramToServer();
  saveTimer = setTimeout(saveLayout, 250);
}
window.addEventListener('beforeunload', saveLayout);

function loadLayout() {
  let L = null;
  try { L = JSON.parse(localStorage.getItem(LAYOUT_KEY)); } catch (e) { /* ignore */ }
  if (!L) return false;
  if (L.program) Object.entries(L.program).forEach(([proc, lines]) => {
    if (PROCEDURES[proc] && Array.isArray(lines) && lines.length) PROCEDURES[proc].lines = lines.slice();
  });
  if (L.cols) {
    if (L.cols.left) $('#col-left').style.flexBasis = L.cols.left;
    if (L.cols.right) $('#col-right').style.flexBasis = L.cols.right;
    if (L.cols.program) $('#win-program').style.flexBasis = L.cols.program;
    if (L.cols.history) $('#win-history').style.flexBasis = L.cols.history;
    if (L.cols.variable) $('#win-variable').style.flexBasis = L.cols.variable;
    if (L.cols.featureinsp) $('#' + FI_IDS.win).style.flexBasis = L.cols.featureinsp;
  }
  if (L.wins) Object.entries(L.wins).forEach(([id, s]) => {
    const w = $('#' + id);
    if (!w) return;
    const rec = wmRec(id);
    if (s.mode === 'floating' && s.floatStyle) {
      w.classList.add('floating');
      ['left', 'top', 'width', 'height'].forEach(p => { if (s.floatStyle[p]) w.style[p] = s.floatStyle[p]; });
      if (s.floatStyle.z) w.style.zIndex = s.floatStyle.z;
      rec.mode = 'floating';
    }
    w.classList.toggle('max', !!s.max);
    w.classList.toggle('hidden-win', !!s.hidden);
    w.classList.toggle('min', !!s.min);
    w.classList.toggle('minimized', !!s.minimized);
  });
  if (L.z) WM.z = Math.max(60, +L.z);
  if (L.breakpoints) state.breakpoints = new Set(L.breakpoints);
  if (L.proc && PROCEDURES[L.proc]) {
    state.proc = L.proc;
    $('#proc-select').value = L.proc;
    $('#status-proc').textContent = `Procedure: ${L.proc}`;
  }
  if (L.showTimes === false) state.showTimes = false;   // the times column can be switched off
  syncTimesButtons();
  if (L.tabs) {
    state.varsTab = L.tabs.vars || 'iconic';
    state.opTab = L.tabs.op || 'parameters';
    state.histTab = L.tabs.hist || 'history';
    [['variable-tabs', state.varsTab], ['operator-tabs', state.opTab], ['history-tabs', state.histTab]]
      .forEach(([bar, tab]) => $$(`#${bar} .tab`).forEach(t => t.classList.toggle('active', t.dataset.tab === tab)));
  }
  Object.entries(WIN_IDS).forEach(([key, id]) => {
    const hidden = $('#' + id).classList.contains('hidden-win');
    $(`#menu-window-list li[data-win="${key}"]`)?.classList.toggle('checked', !hidden);
  });
  if (L.stacks) L.stacks.forEach(ss => {
    if (!ss.members || !ss.members.length) return;
    const s = wmStackCreate();
    wmRec(s.id).mode = ss.mode;
    if (ss.mode === 'floating') {
      wmRow().appendChild(s.el);
      s.el.classList.add('floating');
      if (ss.rect) {
        s.el.style.left = ss.rect.left; s.el.style.top = ss.rect.top;
        s.el.style.width = ss.rect.width; s.el.style.height = ss.rect.height;
      }
    } else {
      const col = $('#' + ss.col) || wmRow();
      const ref = ss.beforeId ? $('#' + ss.beforeId) : null;
      col.insertBefore(s.el, ref);
      s.el.style.flex = ss.flex || '';
      s.el.style.flexBasis = ss.flexBasis || '';
    }
    s.el.classList.toggle('max', !!ss.max);
    s.el.classList.toggle('hidden-win', !!ss.hidden);
    s.el.classList.toggle('min', !!ss.min);
    s.el.classList.toggle('minimized', !!ss.minimized);
    ss.members.forEach(m => { if ($('#' + m)) wmAddToStack(s, m); });
    wmSetActive(s, ss.members.includes(ss.active) ? ss.active : ss.members[0]);
  });
  updateSplitters();
  return true;
}

/* ---------------- splitters ---------------- */
/* A divider sits between two flex items that both grow: the two columns next to
   the centre column, the Program / Operator pair and the Variable / Feature
   Inspection pair. Handing one of them a new flex-basis alone lets the two share
   the free space again, so the divider runs away from the mouse (a 100 px drag
   moved it by ~225 px). Pin both sides to a pixel size (grow 0) while dragging
   and give the grow factors back on release, so the pair behaves like one
   resizable panel. */
function wmDragPair(a, b, a0, b0, d, minA, minB, maxA) {
  if (!a || !b || a === b || a.parentElement !== b.parentElement) return null;
  if (b.classList.contains('hidden-win') || getComputedStyle(b).position === 'absolute') return null;
  const lo = minA - a0, hi = Math.min(maxA - a0, b0 - minB);
  if (hi < lo) return null;                        // no room left for both minima
  const dd = Math.max(lo, Math.min(hi, d));
  wmPinSize(a, a0 + dd);
  wmPinSize(b, b0 - dd);
  return [a, b];
}
/* give an item a pixel size and take its grow factor away for the duration of
   the drag (so it cannot take a share of the free space and drift) */
function wmPinSize(el, size) {
  el.style.flexGrow = '0';
  el.style.flexBasis = size + 'px';
}
function wmReleasePinned(els) {
  els.forEach(el => { el.style.flexGrow = ''; });
}

$$('.splitter').forEach(sp => {
  sp.addEventListener('pointerdown', e => {
    e.preventDefault();
    sp.classList.add('dragging');
    /* capture is a nicety (the pointer may leave the 4 px strip); it throws when
       the pointer is already gone, and that must not break the drag */
    try { sp.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const kind = sp.dataset.split;
    const start = { x: e.clientX, y: e.clientY };
    const left = $('#col-left'), right = $('#col-right'), center = $('#col-center');
    const prog = $('#win-program'), oper = $('#win-operator'), hist = $('#win-history');
    const vars = $('#win-variable'), fi = $('#' + FI_IDS.win);
    const l0 = left.getBoundingClientRect().width;
    const c0 = center.getBoundingClientRect().width;
    const r0 = right.getBoundingClientRect().width;
    const p0 = prog.classList.contains('hidden-win') ? 0 : prog.getBoundingClientRect().height;
    const o0 = oper.classList.contains('hidden-win') ? 0 : oper.getBoundingClientRect().height;
    const h0 = hist.getBoundingClientRect().height;
    const v0 = vars.classList.contains('hidden-win') ? 0 : vars.getBoundingClientRect().height;
    const f0 = fi && !fi.classList.contains('hidden-win') ? fi.getBoundingClientRect().height : 0;
    let pinned = [];
    const move = ev => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      let pair = null;
      if (kind === 'left')    pair = wmDragPair(left, center, l0, c0, dx, 220, 240, 700);
      if (kind === 'right')   pair = wmDragPair(right, center, r0, c0, -dx, 180, 240, 500);
      if (kind === 'left-v')  pair = wmDragPair(prog, oper, p0, o0, dy, 120, 100, 600);
      if (kind === 'right-v') pair = wmDragPair(vars, fi, v0, f0, dy, 60, 90, 900);
      if (pair) {
        /* the two columns next to the centre column sit in a row of three, so
           the third one has to hold its size as well */
        if (kind === 'left')  { wmPinSize(right, r0); pair.push(right); }
        if (kind === 'right') { wmPinSize(left, l0);  pair.push(left); }
        pinned = pair;
      } else {                 // the neighbour is hidden, stacked or a floating window
        if (kind === 'left')    left.style.flexBasis  = Math.min(700, Math.max(220, l0 + dx)) + 'px';
        if (kind === 'right')   right.style.flexBasis = Math.min(500, Math.max(180, r0 - dx)) + 'px';
        if (kind === 'left-v')  prog.style.flexBasis  = Math.min(600, Math.max(120, p0 + dy)) + 'px';
        if (kind === 'right-v') vars.style.flexBasis  = Math.min(900, Math.max(60,  v0 + dy)) + 'px';
      }
      if (kind === 'center-v') hist.style.flexBasis = Math.min(400, Math.max(90, h0 - dy)) + 'px';
      resizeGraphics();
    };
    const up = () => {
      sp.classList.remove('dragging');
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', up);
      sp.removeEventListener('pointercancel', up);
      wmReleasePinned(pinned);
      pinned = [];
      scheduleSave();
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
    sp.addEventListener('pointercancel', up);
  });
});

/* ---------------- tab bars ---------------- */
function wireTabs(tabbarId, onSwitch) {
  $$('#' + tabbarId + ' .tab').forEach(t => t.addEventListener('click', () => {
    $$('#' + tabbarId + ' .tab').forEach(o => o.classList.remove('active'));
    t.classList.add('active');
    onSwitch(t.dataset.tab);
    scheduleSave();
  }));
}
wireTabs('operator-tabs', tab => { state.opTab = tab; renderOperator(); paintThumbs(); });
wireTabs('variable-tabs', tab => { state.varsTab = tab; renderVariables(); });
wireTabs('history-tabs', tab => { state.histTab = tab; renderHistory(); });

/* ---------------- program window: code editor ---------------- */
/* The Program Window is a Monaco (VS Code) editor; the text lives in the model,
   the interpreter reads it back from PROCEDURES.  These helpers move the text
   and the caret between the two. */
function editorLoad() {
  if (!monacoEditor) return;                     // not loaded (yet): nothing to show
  monacoApplyGuard = true;
  monacoEditor.setValue(linesOf(state.proc).join('\n'));
  monacoApplyGuard = false;
  monacoEditor.setPosition({ lineNumber: 1, column: 1 });
  monacoRefreshDecorations();
}

/* Put the caret on a program line and make sure that line is on screen.  This is
   how the Program Window follows the program counter: stepping to a line outside
   the visible part of the text must scroll (Monaco does that itself with
   revealLineInCenterIfOutsideViewport); `focus` is false for automatic calls, so
   a run does not take the keyboard focus away from the Variable Window etc. */
function edFocusLine(n, focus = true) {
  const line = Math.max(1, Math.min(n, linesOf(state.proc).length));
  state.cursor = line;
  if (monacoEditor) {
    monacoEditor.setPosition({ lineNumber: line, column: 1 });
    monacoEditor.revealLineInCenterIfOutsideViewport(line);
    if (focus) monacoEditor.focus();
  }
  renderProgram();
  renderOperator();
  $('#status-line').textContent = `Line: ${line}, Col: 1`;
}

/* The active program line (the green ▶ marker) is a line number, so an edit
   above it would leave it pointing at a line that shifted. If the edited line is
   above the program counter, the counter moves up to that line. */
function edEditAnchor(prevLines, nextLines) {
  const n = Math.min(prevLines.length, nextLines.length);
  let k = 0;
  while (k < n && prevLines[k] === nextLines[k]) k++;
  const first = k + 1;                      // 1-based first line that changed
  if (state.pc === null) return;
  if (state.pcProc !== state.proc) return;  // the counter sits in another procedure: not our lines
  if (state.pc > first) state.pc = first;   // edited line is above it -> move up to it
  if (state.pc > nextLines.length) state.pc = Math.max(1, nextLines.length);
}

/* ---------------- Alt+Enter: open the procedure a line calls ----------------
   HDevelop opens the sub-procedure of the active line with Alt+Enter (each
   procedure is a window of its own there).  Here the Program Window shows one
   procedure at a time, so opening it means switching the window; the Procedure
   box above the window follows and is the way back to the caller.  The running
   line stays where it is: a step after browsing continues the caller (the
   program counter remembers its procedure, see `state.pc`). */

/* the user procedure the caret line calls, or null.  The word under the caret is
   looked at first — but the caret may just as well sit in an argument, so the
   operator of the line itself is the fallback.  Only names the interpreter
   would call (`PROCEDURES`) count: an operator is never "opened". */
function subProcedureAtCaret() {
  const known = n => (n && PROCEDURES[n]) ? n : null;
  const pos = monacoEditor && monacoEditor.getPosition();
  if (pos && monacoEditor.getModel()) {
    const hit = known((monacoEditor.getModel().getWordAtPosition(pos) || {}).word);
    if (hit) return hit;
  }
  const parsed = parseLine(lineText(state.proc, state.cursor) || '');
  return known(parsed && parsed.op);
}

/* show another procedure of the program in the Program Window, caret on `line` */
function showProcedure(name, line = 1) {
  if (!PROCEDURES[name]) return false;
  state.proc = name;
  state.cursor = line;
  const sel = $('#proc-select');
  if (sel) {
    /* a procedure that only exists since the program was loaded has no option yet */
    if (!Array.prototype.some.call(sel.options, o => o.value === name)) sel.add(new Option(name, name));
    sel.value = name;
  }
  const sp = $('#status-proc');
  if (sp) sp.textContent = `Procedure: ${name}`;
  editorLoad();
  edFocusLine(line);
  renderOperator();
  renderVariables();
  renderWatch();
  return true;   // browsing pushes nothing: the program on the server is not touched
}

function openSubProcedure() {
  const name = subProcedureAtCaret();
  if (!name) {
    const parsed = parseLine(lineText(state.proc, state.cursor) || '');
    log(parsed && parsed.op
      ? `Alt+Enter: '${parsed.op}' is not a procedure of this program.`
      : 'Alt+Enter: this line does not call a procedure.', 'msg');
    return;
  }
  if (name === state.proc) {
    log(`Alt+Enter: '${name}' is the procedure already open.`, 'msg');
    return;
  }
  showProcedure(name);
  log(`Opened procedure '${name}' (Alt+Enter) — the Procedure box above the Program Window goes back.`, 'msg');
}

/* gutter click toggles the breakpoint */
function toggleBp(key) {
  state.breakpoints.has(key) ? state.breakpoints.delete(key) : state.breakpoints.add(key);
  renderProgram();
  scheduleSave();
}

/* ---------------- VS Code editor (Monaco), vendored under vendor/monaco ---------------- */
/* Loaded lazily by loadMonaco(); it is the only Program Window editor. */
let monacoEditor = null, monacoDecorations = [], monacoApplyGuard = false, monacoLoadPromise = null;
let monacoDecGuard = false;   // deltaDecorations must not be re-entered (Monaco throws)
window.MonacoEnvironment = {
  getWorkerUrl: () => URL.createObjectURL(new Blob([''], { type: 'application/javascript' })),
};
function monacoReady() {
  if (!monacoLoadPromise) {
    monacoLoadPromise = (typeof require !== 'undefined' && typeof require.config === 'function')
      ? new Promise(res => {
          require.config({ paths: { vs: 'vendor/monaco/vs' } });
          require(['vs/editor/editor.main'], () => res(window.monaco || null), () => res(null));
        })
      : Promise.resolve(null);
  }
  return monacoLoadPromise;
}

function monacoRefreshDecorations() {
  if (!monacoEditor || monacoDecGuard) return;
  monacoDecGuard = true;
  try { monacoApplyDecorations(); monacoRenderTimes(); } finally { monacoDecGuard = false; }
}

function monacoApplyDecorations() {
  const m = window.monaco;
  const dec = [];
  for (const key of state.breakpoints) {
    const i = key.lastIndexOf(':');
    const line = +key.slice(i + 1);
    if (key.slice(0, i) !== state.proc || line > linesOf(state.proc).length) continue;
    dec.push({
      range: new m.Range(line, 1, line, 1),
      options: { glyphMarginClassName: 'mbp', glyphMarginHoverMessage: { value: 'Breakpoint' },
        stickiness: m.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
    });
  }
  if (state.pc !== null && state.pcProc === state.proc && state.pc <= linesOf(state.proc).length) {
    dec.push({
      range: new m.Range(state.pc, 1, state.pc, 1),
      options: { isWholeLine: true, className: 'mpc', glyphMarginClassName: 'mpc-arrow',
        stickiness: m.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
    });
  }
  const e = state.errorLine;                     // line the processor stopped on
  if (e && e.proc === state.proc && e.line <= linesOf(state.proc).length &&
      linesOf(state.proc)[e.line - 1] === e.text) {
    dec.push({
      range: new m.Range(e.line, 1, e.line, 1),
      options: { isWholeLine: true, className: 'merr', glyphMarginClassName: 'merr-arrow',
        stickiness: m.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
    });
  }
  monacoDecorations = monacoEditor.deltaDecorations(monacoDecorations, dec);
}

/* Hover text for a variable: read from the same state the Variable Window
   shows, so the tooltip always matches the values of the current run. */
function variableHoverInfo(name) {
  const cv = state.ctrl.get(name);
  if (cv) {
    return [
      { value: `**${name}** · control \`${cv.type}\`` },
      { value: '```text\n' + String(cv.value) + '\n```' },
    ];
  }
  const rec = state.iconic.get(name);
  if (rec) {
    const out = [`**${name}** · iconic \`${rec.type || rec.kind || 'iconic'}\``];
    if (rec.mat) out.push(`Size: ${rec.mat.cols}×${rec.mat.rows}`);
    if (rec.count) out.push(`Objects: ${rec.count}`);
    return [{ value: out.join('  \n') }];
  }
  const decl = declaredVars();          // declared by the program but not assigned yet
  if (decl.ctrl.includes(name) || decl.iconic.includes(name)) {
    return [{ value: `**${name}** · undefined\n\nDeclared, not assigned yet.` }];
  }
  return null;
}

/* ------------------- hover on an arithmetic expression -------------------
   `Width*0.5`, `640/2`, `(Width + 1) * 2` … Hovering any character of such a
   run — including the operator — lists the operands with their current value
   and the computed result. */
const EXPR_RE = /(?:[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|\([^()]*\))(?:\s*[+\-*/]\s*(?:[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|\([^()]*\)))+/g;

/* true when offset i of `line` sits inside a '…' literal ('' is an escaped quote) */
function inStringLiteral(line, i) {
  let q = false;
  for (let k = 0; k < i && k < line.length; k++) {
    if (line[k] !== "'") continue;
    if (q && line[k + 1] === "'") { k++; continue; }
    q = !q;
  }
  return q;
}

/* the expression run covering 1-based `column`, or null */
function expressionAt(line, column) {
  if (/^\s*\*/.test(line)) return null;              // comment line
  const i = column - 1;
  if (i < 0 || inStringLiteral(line, i)) return null;
  EXPR_RE.lastIndex = 0;
  for (let m; (m = EXPR_RE.exec(line)); ) {
    if (i >= m.index && i < m.index + m[0].length) return { text: m[0], start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/* concise number text for the tooltip (640, 320.5, 0.0001 …) */
function fmtNum(v) {
  if (Number.isInteger(v)) return String(v);
  return String(+v.toFixed(6));
}

/* Substitute the control variables of `expr` with their current value and try
   to evaluate it. Returns the operand list and the result (null while an
   operand is undefined, non-numeric, or the expression does not compute). */
function evaluateExpr(expr) {
  const TOKEN = /[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[+\-*/()]/g;
  const operands = [];
  let js = '', last = 0, known = true;
  for (let m; (m = TOKEN.exec(expr)); ) {
    js += expr.slice(last, m.index);
    last = m.index + m[0].length;
    const tok = m[0];
    if (!/^[A-Za-z_]/.test(tok)) { js += tok; continue; }
    const cv = state.ctrl.get(tok);
    const num = cv ? Number(cv.value) : NaN;
    if (cv && isFinite(num)) {
      js += `(${num})`;
      operands.push(`${tok} = ${cv.value}`);
    } else {
      js += 'NaN';
      operands.push(cv ? `${tok} = ${cv.value} (not a number)` : `${tok} = undefined`);
      known = false;
    }
  }
  js += expr.slice(last);
  let result = null;
  if (known) {
    try {
      const v = Function('"use strict";return (' + js + ')')();
      if (typeof v === 'number' && isFinite(v)) result = v;
    } catch (e) { result = null; }
  }
  return { operands, result, js };
}

function expressionHoverInfo(expr) {
  const { operands, result } = evaluateExpr(expr);
  const md = [`\`${expr}\``];
  if (operands.length) md.push(operands.join('  \n'));
  md.push(result !== null
    ? `**= ${fmtNum(result)}**`
    : '_needs every operand to be defined_');
  return [{ value: md.join('\n\n') }];
}

function setupMonaco(m) {
  m.languages.register({ id: 'halcon', extensions: ['.hdev', '.ovs'] });
  m.languages.setLanguageConfiguration('halcon', {
    comments: { lineComment: '*' },
    brackets: [['(', ')']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
  });
  m.languages.setMonarchTokensProvider('halcon', {
    tokenizer: {
      root: [
        [/^\s*\*.*$/, 'comment'],
        [/'[^']*'/, 'string'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [/\b(if|elseif|else|endif|for|endfor|while|endwhile|try|catch|endtry|return|exit|stop)\b/, 'keyword'],
        [/\b(?:dev|disp)_[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/, 'devop'],
        [/[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/, 'operator'],
      ],
    },
  });
  m.editor.defineTheme('ovs-dark', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'comment',  foreground: '6a9955', fontStyle: 'italic' },
      { token: 'string',   foreground: 'ce9178' },
      { token: 'number',   foreground: 'b5cea8' },
      { token: 'keyword',  foreground: 'c586c0' },
      { token: 'devop',    foreground: '4ec9b0' },
      { token: 'operator', foreground: '6cb6ff' },
    ],
    colors: {
      'editor.background': '#1f2124',
      'editorLineNumber.foreground': '#62676f',
      'editorLineNumber.activeForeground': '#d4d6da',
      'editorLineHighlight.background': '#26292d',
    },
  });
  monacoEditor = m.editor.create($('#editor-monaco'), {
    value: linesOf(state.proc).join('\n'),
    language: 'halcon',
    theme: 'ovs-dark',
    glyphMargin: true,
    minimap: { enabled: false },
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'Consolas, monospace',
    fontSize: 12.5,
    lineHeight: 19,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    fixedOverflowWidgets: true,
    padding: { top: 2 },
  });
  monacoEditor.onDidScrollChange(() => monacoRenderTimes());   // the times do not scroll themselves
  monacoEditor.onDidLayoutChange(() => monacoRenderTimes());   // a resize moves the gutter band
  monacoEditor.onDidChangeModelContent(() => {
    if (monacoApplyGuard) return;
    const next = monacoEditor.getValue().split('\n');
    edEditAnchor(PROCEDURES[state.proc].lines, next);   // keep the active line on its statement
    PROCEDURES[state.proc].lines = next;
    renderVariables();
    renderOperator();
    paintThumbs();
    monacoRefreshDecorations();
    $('#proc-modified').style.visibility = 'visible';
    scheduleSave();
  });
  monacoEditor.onDidChangeCursorPosition(e => {
    state.cursor = e.position.lineNumber;
    $('#status-line').textContent = `Line: ${e.position.lineNumber}, Col: ${e.position.column}`;
    renderProgram();
    renderOperator();
  });
  monacoEditor.onMouseDown(e => {
    const t = e.target.type;
    if (e.target.position &&
        (t === m.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
         t === m.editor.MouseTargetType.GUTTER_LINE_NUMBERS)) {
      toggleBp(`${state.proc}:${e.target.position.lineNumber}`);
    }
  });
  /* Alt+Enter itself is handled on the document (see the keyboard section): an
     action of this editor cannot own the key, because Monaco resolves no
     dynamic keybindings in this build.  The action is kept for the context menu
     and the command palette; its `run` is what both routes end in. */
  monacoEditor.addAction({
    id: 'ovs.openSubProcedure',
    label: 'Open Sub-Procedure',
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.5,
    run: () => openSubProcedure(),
  });
  m.languages.registerCompletionItemProvider('halcon', {
    triggerCharacters: ['('],
    provideCompletionItems: (model, position) => {
      const w = model.getWordUntilPosition(position);
      const range = new m.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn);
      const before = model.getLineContent(position.lineNumber).slice(0, w.startColumn - 1);
      const items = [];
      if (before.includes('(')) {
        const decl = declaredVars();
        decl.iconic.forEach(k => items.push({ label: k, kind: m.languages.CompletionItemKind.Variable, range }));
        decl.ctrl.forEach(k => items.push({ label: k, kind: m.languages.CompletionItemKind.Variable, range }));
        state.iconic.forEach((_, k) => items.push({ label: k, kind: m.languages.CompletionItemKind.Value, range }));
        state.ctrl.forEach((_, k) => items.push({ label: k, kind: m.languages.CompletionItemKind.Value, range }));
      } else {
        /* the line the call is written to is the context its iconic inputs are
           taken from, so the results of the lines above link into the snippet */
        const ctx = { proc: state.proc, line: position.lineNumber };
        for (const [name, info] of Object.entries(OPINFO)) {
          /* like the autocomplete: HDevelop's defaults and the linked iconic
             inputs are written as text, the remaining parameters as Tab stops
             (${1:Name}); they are numbered without gaps so Tab walks them in
             the order of the arguments */
          const entries = opInsertEntries(name, ctx);
          let tab = 0;
          const args = entries
            .map(e => e.linked ? e.txt : '${' + (++tab) + ':' + e.txt + '}')
            .join(', ');
          items.push({
            label: name,
            kind: isDisplayOp(name)
              ? m.languages.CompletionItemKind.Function : m.languages.CompletionItemKind.Method,
            detail: `${name} ( ${info.params.map(p => p[0]).join(', ')} )`,
            insertText: `${name} ( ${args} )`,
            insertTextRules: m.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          });
        }
      }
      return { suggestions: items };
    },
  });
  /* hover a variable -> tooltip with its current value / type;
     hover an arithmetic expression (also on its operator) -> operand values
     and the computed result, e.g. `Width*0.5` */
  m.languages.registerHoverProvider('halcon', {
    provideHover: (model, position) => {
      const expr = expressionAt(model.getLineContent(position.lineNumber), position.column);
      if (expr) {
        return {
          range: new m.Range(position.lineNumber, expr.start + 1, position.lineNumber, expr.end + 1),
          contents: expressionHoverInfo(expr.text),
        };
      }
      const w = model.getWordAtPosition(position);
      if (!w) return null;
      const contents = variableHoverInfo(w.word);
      if (!contents) return null;
      return {
        range: new m.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn),
        contents,
      };
    },
  });
  monacoRefreshDecorations();
}

/* Create the Program Window editor.  Called once, from init(); the scripts it
   needs (the Monaco loader and editor bundles) are fetched on first call. */
async function loadMonaco() {
  if (monacoEditor) return monacoEditor;
  setStatus('Loading VS Code editor…');
  const m = await monacoReady();
  if (!m) {
    log('VS Code editor (Monaco) failed to load — the Program Window stays empty.', 'err');
    setStatus('Ready');
    return null;
  }
  setupMonaco(m);
  renderProgram();
  renderOperator();
  setStatus('Ready');
  return monacoEditor;
}

/* ---------------- program files: Open / Save (.odev, .hdev) ----------------
   A program is one text file holding every procedure, each introduced by a
   `* procedure: <name>` line — the same format as program.ovs, so a file saved
   here stays editable in an external editor and in the dev server's live sync.
   Saving defaults to `.odev`. HDevelop `.hdev` files are read as well
   (`procedure <name> (...)` … `endprocedure` blocks, plus the main program
   before the first procedure); a bare operator list loads as `main`. */
const PROGRAM_ACCEPT = '.odev,.hdev,.ovs,text/plain';
const PROGRAM_FILTER = {
  description: 'OpenCVS / HDevelop program',
  accept: { 'text/plain': ['.odev', '.hdev'] },
};
const hasExt = name => /\.[A-Za-z0-9]{1,6}$/.test(name);
const withExt = (name, ext) => (hasExt(name) ? name : name + ext);

/* text of a program file handed to the user (.odev): main plus every procedure
   that differs from the built-in demo program, i.e. everything you wrote or
   opened. Untouched sample procedures are left out — they are part of the IDE,
   not of your program. (`dropped` is only used for the log message.) */
function serializeProgramFile() {
  const names = Object.keys(PROCEDURES).filter(n => n === 'main' || !isBuiltinDemo(n));
  const dropped = Object.keys(PROCEDURES).length - names.length;
  return {
    text: names.map(n =>
      `* procedure: ${n}${procSignatureText(PROCEDURES[n].params)}\n${PROCEDURES[n].lines.join('\n')}`
    ).join('\n') + '\n',
    dropped,
  };
}

/* ---------------- HDevelop XML (.hdev) ------------------------------------
   A .hdev file written by HDevelop's export is an XML document: <hdevelop …>
   containing one <procedure name="…"> per procedure, an <interface> declaring
   its parameters and a <body> holding the program.  The program lines are <l>
   elements, comment / blank lines are <c> elements, and the source is
   XML-escaped (a '<' is written &lt;).  Only the text of those elements is the
   program — the wrapper itself would otherwise be read as program lines. */
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/* HALCON line continuation: a trailing '\' joins the next line — the tuple
   literal of `pixpum := \ [ … ]` is one program line in HDevelop, while the XML
   export keeps the physical editor lines.  Every '\' marker is dropped, so the
   physical lines are concatenated into the single program line they mean. */
function joinContinuations(lines) {
  const out = [];
  let joinable = false;                    // the line before ended in a '\'
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const continues = /\\+$/.test(line);
    const frag = line.replace(/\\+$/, '');
    if (joinable && out.length) out[out.length - 1] += frag;
    else out.push(frag);
    joinable = continues;
  }
  return out;
}

/* The <interface> of a procedure: its parameters in the order of the call —
   iconic inputs, iconic outputs, control inputs, control outputs.  That is the
   order HDevelop uses in the signature, so the arguments of a call are bound
   positionally. */
const IFACE_GROUPS = [['io', 'iconic', 'in'], ['oo', 'iconic', 'out'],
                      ['ic', 'ctrl', 'in'], ['oc', 'ctrl', 'out']];

function parseInterface(xml) {
  const params = [];
  for (const [tag, type, dir] of IFACE_GROUPS) {
    const g = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
    if (!g) continue;
    const parRe = /<par\b[^>]*\bname="([^"]+)"[^>]*\/?>/gi;
    let m;
    while ((m = parRe.exec(g[1]))) params.push({ name: m[1], type, dir });
  }
  return params;
}

/* text of a .hdev XML document -> { procedure name: [line, …] }, every line
   list carrying its `params` from the <interface> (empty for `main`) */
function parseHdevelopXml(text) {
  const procs = {};
  const procRe = /<procedure\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/procedure>/gi;
  let pm;
  while ((pm = procRe.exec(text))) {
    const raw = [];
    const elemRe = /<(l|c)>([\s\S]*?)<\/\1>/g;      // <l> program line, <c> comment / blank
    let em;
    while ((em = elemRe.exec(pm[2]))) {
      for (const l of decodeXmlEntities(em[2]).split('\n')) {
        const t = l.replace(/[ \t]+$/, '');
        /* a <c> that is not already a '* comment' becomes one, so the text
           survives the editor and the line checker */
        if (em[1] === 'c' && t.trim() && !/^\s*\*/.test(t)) raw.push('* ' + t.trim());
        else raw.push(t);
      }
    }
    const lines = joinContinuations(raw);
    lines.params = parseInterface(pm[2]);
    procs[pm[1]] = lines;
  }
  return procs;
}

/* The signature of a procedure in the OpenCVS program format.  It is written on
   the '* procedure:' line in HALCON's order — iconic inputs : iconic outputs :
   control inputs : control outputs — with groups left empty where there are
   none, exactly like HDevelop prints a procedure's signature:
     * procedure: find_center (BaseImage : CenterCross, Cross : : Row, Column)
   A program without signatures can still not pass arguments (HDevelop: "the
   procedure declares no interface"); `_` discards an argument at the call. */
const OVS_IFACE_GROUPS = [['iconic', 'in'], ['iconic', 'out'], ['ctrl', 'in'], ['ctrl', 'out']];
function parseProcSignature(text) {
  if (text == null || !String(text).trim()) return null;
  const groups = String(text).trim().replace(/^\(([\s\S]*)\)$/, '$1').split(':');
  if (groups.length > OVS_IFACE_GROUPS.length) {
    log(`Procedure signature '${String(text).trim()}' has ${groups.length} groups — at most 4 ` +
      '(iconic in : iconic out : control in : control out).', 'err');
    return null;
  }
  const params = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const [type, dir] = OVS_IFACE_GROUPS[gi];
    for (const raw of groups[gi].split(',')) {
      const name = raw.trim();
      if (!name) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        log(`Procedure signature '${String(text).trim()}': '${name}' is not a parameter name.`, 'err');
        return null;
      }
      params.push({ name, type, dir });
    }
  }
  return params.length ? params : null;
}

/* the signature of `params` as it is written on the '* procedure:' line, empty
   for a procedure without one (main, or any procedure taking no arguments) */
function procSignatureText(params) {
  if (!Array.isArray(params) || !params.length) return '';
  const groups = [[], [], [], []];
  for (const p of params) {
    const gi = p.type === 'iconic' ? (p.dir === 'out' ? 1 : 0) : (p.dir === 'out' ? 3 : 2);
    groups[gi].push(p.name);
  }
  return ` (${groups.map(g => g.join(', ')).join(' : ')})`;
}

function parseProgram(text) {
  const trim = a => { const b = a.slice(); while (b.length && !b[b.length - 1].trim()) b.pop(); return b; };
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const procs = {};
  if (/<hdevelop\b/i.test(text) || /<procedure\b[^>]*\bname=/i.test(text)) {   // HDevelop XML export
    Object.assign(procs, parseHdevelopXml(text));
  } else if (lines.some(l => /^\s*\*\s*procedure\s*:/i.test(l))) {    // OpenCVS program format
    let cur = null;
    for (const l of lines) {
      const m = l.match(/^\s*\*\s*procedure\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*(\([\s\S]*\))?\s*$/i);
      if (m) {
        cur = m[1];
        if (!procs[cur]) procs[cur] = [];
        const sig = parseProcSignature(m[2]);          // the '(…)' of the header line
        if (sig) procs[cur].params = sig;
        continue;
      }
      if (cur) procs[cur].push(l);
    }
  } else if (lines.some(l => /^\s*procedure\s+[A-Za-z_]/i.test(l))) {  // HDevelop .hdev
    let cur = 'main';
    procs.main = [];
    for (const l of lines) {
      const m = l.match(/^\s*procedure\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/i);
      if (m) { cur = m[1]; if (!procs[cur]) procs[cur] = []; continue; }
      if (/^\s*endprocedure\b/i.test(l)) { cur = null; continue; }
      if (cur) procs[cur].push(l);
    }
  } else {                                                            // bare operator list
    procs.main = lines.slice();
  }
  for (const k of Object.keys(procs)) {
    const params = procs[k].params;                 // <interface> of a procedure
    const t = trim(procs[k]);
    if (params) t.params = params;
    procs[k] = t;
  }
  if (procs.main && !procs.main.length) delete procs.main;
  return procs;
}

function refreshProcSelect() {
  const sel = $('#proc-select');
  if (!sel) return;
  sel.innerHTML = Object.keys(PROCEDURES)
    .map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  if (!PROCEDURES[state.proc]) state.proc = Object.keys(PROCEDURES)[0];
  sel.value = state.proc;
}

function setProgramFileLabel() {
  const name = state.progFile;
  const cap = $('.mb-caption');
  if (cap) cap.textContent = `OpenCVisionStudio — ${name}`;
  document.title = `OpenCVisionStudio (OpenCVS) — ${name}`;
}

/* does any procedure of the loaded program read the folder it lives in? */
function usesProgramFolder() {
  for (const proc of Object.values(PROCEDURES)) {
    for (const text of (proc.lines || [])) {
      const op = parseLine(text)?.op;
      if (op === 'list_image_files') return true;
    }
  }
  return false;
}

/* replace the whole program with the contents of a file.  `dirHint` is the
   folder the program was fetched from when it has a URL (see
   openProgramFromServer); a program picked from disk has none.  The empty
   string is a *known* folder (the page's own, which the dev server can list),
   so it is told apart from "unknown" by `null`/`undefined` */
function loadProgram(text, fileName, dirHint = null) {
  const procs = parseProgram(text);
  const names = Object.keys(procs);
  if (!names.length || !names.some(n => procs[n].length)) {
    log(`Open Program: '${fileName}' contains no program text.`, 'err');
    return false;
  }
  for (const k of Object.keys(PROCEDURES)) delete PROCEDURES[k];
  for (const n of names) PROCEDURES[n] = { lines: procs[n], params: procs[n].params };
  state.proc = entryProcName();
  state.progFile = fileName || state.progFile;
  resetProgramState();
  refreshProcSelect();
  setProgramFileLabel();
  $('#proc-modified').style.visibility = 'hidden';
  setStatus('Ready');
  log(`Opened '${fileName}' — ${names.length} procedure(s): ${names.join(', ')}.`, 'msg');
  pushProgramToServer();
  /* The folder the program reads (list_image_files ('./')).  A program with a
     URL carries its folder with it; a program picked from disk has none, but a
     folder granted or loaded for this program name once is remembered. */
  if (dirHint != null) {
    IMAGE_DIR = dirHint;
    IMAGE_DIR_HANDLE = null;
    IMAGE_URLS.clear();
    renderOperator();
  } else {
    const remembered = recallProgDir(fileName);
    if (remembered != null && !IMAGE_DIR && !IMAGE_DIR_HANDLE) {
      IMAGE_DIR = remembered;
      const shown = remembered || '(the page folder)';
      log(`Working folder: '${shown}' — remembered for '${fileName}'.`, 'msg');
      renderOperator();
      if (usesProgramFolder()) {                    // still there? say so if not
        enumImagesAtDir('./', IMAGE_FILE_RE).then(found => {
          if (!found) log(`Working folder: '${shown}' cannot be listed any more — grant ` +
            `the folder again with "Folder…" if the images moved.`, 'warn');
        }).catch(() => {});
      }
    } else if (usesProgramFolder() && !IMAGE_DIR && !IMAGE_DIR_HANDLE) {
      log('Working folder: none yet — this program reads its own folder with ' +
        `list_image_files ('./'). A page cannot see the folder '${fileName}' was opened from: ` +
        'grant it with "Folder…" in the Operator Window (or "Load folder…") before running. ' +
        'It is then remembered for this program; "Browse Server Folder…" avoids the step.', 'warn');
    }
  }
  return true;
}

/* start a fresh program: the whole program is replaced by an empty main
   procedure (asking first, since the current program is dropped) */
function newProgram() {
  const hasCode = Object.values(PROCEDURES)
    .some(p => p.lines.some(l => l.trim() && !/^\s*\*/.test(l)));
  if (hasCode && !window.confirm('New Program: discard the current program?')) return;
  for (const k of Object.keys(PROCEDURES)) delete PROCEDURES[k];
  PROCEDURES.main = { lines: ['* new program', ''] };
  state.proc = 'main';
  state.progFile = 'program.odev';
  resetProgramState();
  refreshProcSelect();
  setProgramFileLabel();
  $('#proc-modified').style.visibility = 'hidden';
  setStatus('Ready');
  log('New program created.', 'msg');
  pushProgramToServer();
}

/* drop the variables, graphics contents and execution state of the old
   program and redraw everything for the procedure that is now selected */
function resetProgramState() {
  state.running = false;
  state.stopRequested = false;
  setLive(false);
  clearRunState();
  clearTimes();                          // the times belong to the program that was replaced
  state.pc = null;
  state.cursor = 1;
  editorLoad();
  syncUI();
  renderGraphics(mainGfx);
}

function openProgram() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = PROGRAM_ACCEPT;
  inp.style.display = 'none';
  inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    inp.remove();
    if (!f) return;
    const rd = new FileReader();
    rd.onerror = () => log(`Open Program: '${f.name}' could not be read.`, 'err');
    rd.onload = () => loadProgram(String(rd.result), f.name);
    rd.readAsText(f);
  });
  document.body.appendChild(inp);
  inp.click();
}

function downloadProgram(text, fname, note = '') {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  log(`Program saved: ${fname}${note}`, 'msg');
}

function saveProgram(name) {
  const fname = withExt(String(name || state.progFile || 'program.odev').trim(), '.odev');
  const { text, dropped } = serializeProgramFile();
  const note = dropped ? ` (${dropped} unchanged demo procedure(s) left out)` : '';
  state.progFile = fname;
  setProgramFileLabel();
  $('#proc-modified').style.visibility = 'hidden';
  pushProgramToServer();
  /* Chromium offers a real Save-as dialog; everywhere else the file is
     downloaded to the browser's download folder. */
  if (window.showSaveFilePicker) {
    window.showSaveFilePicker({ suggestedName: fname, types: [PROGRAM_FILTER] })
      .then(async h => {
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
        state.progFile = h.name;
        setProgramFileLabel();
        log(`Program saved: ${h.name}${note}`, 'msg');
      })
      .catch(err => {
        if (err && err.name === 'AbortError') { log('Save Program: cancelled.', 'msg'); return; }
        downloadProgram(text, fname, note);
      });
  } else {
    downloadProgram(text, fname, note);
  }
}

/* Save As: with the file picker the dialog already asks for a name; the
   prompt is the fallback for browsers without it. */
function saveProgramAs() {
  if (window.showSaveFilePicker) { saveProgram(); return; }
  const name = window.prompt('Save program as (.odev or .hdev):', state.progFile);
  if (name && name.trim()) saveProgram(name.trim());
}

/* ---------------- external editor sync (tools/serve.js) ---------------- */
/* When served by the local dev server, program.ovs on disk is the source of
   truth: edit the program in an external editor (e.g. VS Code) and the IDE
   reloads it live; IDE edits write the file back. file:// or plain static
   hosting runs in local mode (no sync). */
const extSync = { active: false, applying: false, ready: false, fromFile: new Set() };
let pushTimer = null;

function applyExternalProgram(procs, headers, msg) {
  extSync.applying = true;
  let changed = false, added = false;
  const names = new Set();
  /* A procedure the file defines is created here when the page does not have it
     yet.  Requiring the name to exist first meant the file was never loaded:
     a page starts on the built-in demo (main, detect_features, …), so an edit to
     program.ovs updated the demo's `main` in the editor and the program's own
     procedures (`find_center`, …) stayed missing — the file on screen, the demo
     in the run. */
  for (const [name, lines] of Object.entries(procs)) {
    if (!Array.isArray(lines)) continue;
    names.add(name);
    if (!PROCEDURES[name]) { PROCEDURES[name] = { lines: lines.slice() }; added = true; }
    else PROCEDURES[name].lines = lines.slice();
    /* the signature of the '* procedure:' line on disk, so an interface typed in
       the external editor binds arguments exactly like one in the program */
    const sig = parseProcSignature(headers && headers[name]);
    if (sig) PROCEDURES[name].params = sig;
    else delete PROCEDURES[name].params;
    changed = true;
  }
  /* a procedure that an earlier version of the file defined and this one does
     not is gone from the program; the built-in demo procedures, which no file
     ever defines, stay where they are */
  for (const old of extSync.fromFile) {
    if (!names.has(old) && PROCEDURES[old]) { delete PROCEDURES[old]; changed = true; }
  }
  extSync.fromFile = names;
  if (changed) {
    state.pc = null;
    editorLoad();
    renderVariables();
    renderOperator();
    if (added) refreshProcSelect();       // the dropdown lists the file's procedures
    log(msg, 'msg');
  }
  extSync.applying = false;
  extSync.ready = true;                   // program.ovs has been read: pushes may start
}

function pushProgramToServer() {
  /* Not before program.ovs has been read: init renders the window layout and
     the first display re-renders the taskbar, both of which save, and a push
     from the demo state would write the demo over the program on disk. */
  if (!extSync.active || !extSync.ready || extSync.applying) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    /* Only the procedures that are yours are written back — the same rule as
       Save Program (main plus everything that differs from the built-in demo).
       PROCEDURES also holds the demo procedures the IDE starts with, and
       sending them turned program.ovs into demo + program: *any* incidental
       save did it, because re-rendering the taskbar, switching a tab, dragging
       a splitter and toggling a breakpoint all call this.  Losing the file to
       a window drag is not a thing that should be possible. */
    const names = Object.keys(PROCEDURES).filter(n => n === 'main' || !isBuiltinDemo(n));
    const procs = {}, headers = {};
    for (const n of names) {
      procs[n] = PROCEDURES[n].lines;
      headers[n] = procSignatureText(PROCEDURES[n].params);
    }
    fetch('/api/program', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ procs, headers }),
    }).catch(() => {});
  }, 250);
}

async function initExtSync() {
  let r;
  /* Only the request is allowed to fail quietly (file:// has no dev server):
     an error while *applying* the program must not be swallowed, or a program
     that does not load looks like a program that is already loaded. */
  try { r = await fetch('/api/program'); } catch (e) { return; }
  if (!r.ok) return;                       // not served by tools/serve.js
  extSync.active = true;
  const data = await r.json();
  if (data.procs && Object.keys(data.procs).length) {
    applyExternalProgram(data.procs, data.headers, 'Program loaded from program.ovs (external editor sync active).');
  } else {
    extSync.ready = true;                  // nothing on disk to protect
    pushProgramToServer();                 // first run: seed the file from the editor content
  }
  const es = new EventSource('/events');
  es.onmessage = ev => {
    try {
      const d = JSON.parse(ev.data);
      if (d.kind === 'program') {
        applyExternalProgram(d.procs, d.headers, 'program.ovs changed on disk - program reloaded.');
      }
    } catch (e) { /* ignore malformed events */ }
  };
  log('External editor sync active (program.ovs).', 'msg');
}

/* ---------------- operator insert line + autocomplete ---------------- */
let acItems = [], acIndex = -1;
const opInput = $('#op-input'), acDrop = $('#ac-dropdown'), peditMode = $('#pedit-mode');
$('#proc-modified').style.visibility = 'hidden';

function acCurrentWord() {
  const caret = opInput.selectionStart || opInput.value.length;
  const before = opInput.value.slice(0, caret);
  const m = before.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
  return { word: m ? m[1] : '', start: m ? caret - m[1].length : caret, caret };
}

/* the line a statement typed into the operator input line will be written to */
const insertionLine = () =>
  Math.min(monacoEditor?.getPosition()?.lineNumber || state.cursor, linesOf(state.proc).length);

function buildSuggestions() {
  const { word, start, caret } = acCurrentWord();
  const lw = word.toLowerCase();
  const hasParen = opInput.value.slice(0, caret).includes('(');
  acItems = [];
  if (!hasParen) {
    for (const [name, info] of Object.entries(OPINFO)) {
      if (lw && !name.toLowerCase().includes(lw)) continue;
      acItems.push({
        label: name,
        badge: isDisplayOp(name) ? 'dev' : 'op',
        sig: `${name} ( ${info.params.map(p => p[0]).join(', ')} )`,
        apply: () => {
          /* the operator input line is inserted at the caret (commitLine), so
             that line is where its iconic inputs are linked from */
          const { entries, starts, text } = opArgText(name, { proc: state.proc, line: insertionLine() });
          const beforeTxt = opInput.value.slice(0, start);
          const afterTxt = opInput.value.slice(caret);
          opInput.value = `${beforeTxt}${name} (${text})${afterTxt}`;
          const base = start + name.length + 2;          // just after the '(' of the call
          const first = entries.findIndex(e => e.placeholder);
          opInput.focus();
          if (first < 0) opInput.setSelectionRange(base + text.length, base + text.length);
          else opInput.setSelectionRange(base + starts[first], base + starts[first] + entries[first].txt.length);
        },
      });
    }
    acItems.sort((a, b) => a.label.indexOf(lw) - b.label.indexOf(lw) || a.label.localeCompare(b.label));
  } else {
    const add = (map, badge) => {
      for (const k of map.keys()) {
        if (lw && !k.toLowerCase().includes(lw)) continue;
        acItems.push({ label: k, badge, sig: '', apply: () => replaceWord(k, start, caret) });
      }
    };
    add(state.iconic, 'iconic');
    add(state.ctrl, 'control');
  }
  acItems = acItems.slice(0, 12);
  acIndex = acItems.length ? 0 : -1;
}

function replaceWord(text, start, caret) {
  opInput.value = opInput.value.slice(0, start) + text + opInput.value.slice(caret);
  opInput.focus();
  opInput.setSelectionRange(start + text.length, start + text.length);
}

function renderAC() {
  if (!acItems.length) { acDrop.classList.add('hidden'); acDrop.innerHTML = ''; return; }
  acDrop.innerHTML = acItems.map((it, i) =>
    `<div class="ac-item ${i === acIndex ? 'active' : ''}" data-i="${i}">` +
    `<span class="ac-badge ${it.badge}">${it.badge}</span>` +
    `<span class="ac-label">${it.label}</span>` +
    (it.sig ? `<span class="ac-sig">${esc(it.sig)}</span>` : '') + `</div>`).join('');
  acDrop.classList.remove('hidden');
  $$('.ac-item', acDrop).forEach(el => {
    el.addEventListener('mousedown', e => { e.preventDefault(); acIndex = +el.dataset.i; acItems[acIndex].apply(); closeAC(); });
    el.addEventListener('mouseenter', () => { acIndex = +el.dataset.i; $$('.ac-item', acDrop).forEach(o => o.classList.toggle('active', o === el)); });
  });
}
function closeAC() { acItems = []; acIndex = -1; acDrop.classList.add('hidden'); }

opInput.addEventListener('input', () => { buildSuggestions(); renderAC(); });
opInput.addEventListener('blur', () => setTimeout(closeAC, 120));
opInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' && acItems.length) { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; renderAC(); }
  else if (e.key === 'ArrowUp' && acItems.length) { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; renderAC(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (acItems.length && acIndex >= 0) { acItems[acIndex].apply(); closeAC(); }
    else commitLine();
  }
  else if (e.key === 'Tab' && acItems.length) { e.preventDefault(); acItems[acIndex].apply(); closeAC(); }
  else if (e.key === 'Escape') {
    if (acItems.length) closeAC();
    else { opInput.value = ''; peditMode.textContent = ''; }
  }
});

function commitLine() {
  const text = opInput.value.trim();
  if (!text || !monacoEditor) return;
  const line = insertionLine();
  monacoEditor.executeEdits('op-input', [{
    range: new window.monaco.Range(line, 1, line, 1),
    text: text + '\n',
    forceMoveMarkers: true,
  }]);
  monacoEditor.setPosition({ lineNumber: line, column: text.length + 1 });
  monacoEditor.focus();
  state.cursor = line;
  opInput.value = '';
  peditMode.textContent = '';
  $('#proc-modified').style.visibility = 'visible';
  scheduleSave();
  log(`Line inserted: ${text}`, 'msg');
}

function repaintVarCard(name) {
  const rec = state.iconic.get(name);
  const el = $(`.vcard[data-var="${name}"] canvas`);
  if (!rec || !el) return;
  const x = el.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, el.width, el.height);
  paintIconic(rec, x, el.width, el.height);
  if (state.selectedVar === name) updateVarDetails();
}

$('#proc-select').addEventListener('change', e => {
  /* Picking a procedure here is browsing, exactly like Alt+Enter: the window
     switches, a paused run keeps its counter (F5/F6/F8 snap back to the line the
     program is at, see backToCounterProcedure) and the program is not pushed
     back to the server. */
  if (!showProcedure(e.target.value)) return;
  const sl = $('#status-line');
  if (sl) sl.textContent = 'Line: 1, Col: 1';
});

/* ---------------- variable window ---------------- */
/* HDevelop semantics: single click selects a variable, double click dev_displays it */
function displayIconic(name) {
  const rec = state.iconic.get(name);
  if (!rec) return;
  const G = gfxActive();
  try {
    gfxShowItem(G, name);
  } catch (err) {
    log(`dev_display (${name}): ${err.message}`, 'err');
    return;
  }
  renderVariables();
  log(`dev_display (${name}) → graphics window ${G.handle}`);
}

$('#variable-body').addEventListener('click', e => {
  const card = e.target.closest('.vcard');
  if (card) {
    if (e.target.closest('.vcard-watch')) { toggleWatch(card.dataset.var); return; }
    if (e.detail >= 2) { displayIconic(card.dataset.var); return; }
    state.selectedVar = card.dataset.var;
    $$('.vcard', e.currentTarget).forEach(c => c.classList.toggle('selected', c === card));
    updateVarDetails();
    return;
  }
  const tr = e.target.closest('tr[data-cname]');
  if (tr) {
    if (e.target.closest('.vcard-watch')) { toggleWatch(tr.dataset.cname); return; }
    state.selectedCtrl = tr.dataset.cname;
    renderVariables();
  }
});

/* watch list: live value strip, survives clear/run */
function toggleWatch(name) {
  if (!name) return;
  state.watch.has(name) ? state.watch.delete(name) : state.watch.add(name);
  log(`${state.watch.has(name) ? 'Watching' : 'Unwatched'}: ${name}`, 'msg');
  renderVariables();
  renderWatch();
}

function renderWatch() {
  const el = $('#vw-watchlist');
  if (!el) return;
  if (!state.watch.size) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = [...state.watch].map(name => {
    const iv = state.iconic.get(name), cv = state.ctrl.get(name);
    const val = iv ? (iv.type || iv.kind) + (iv.mat ? ` ${iv.mat.cols}×${iv.mat.rows}` : '')
      : cv ? `${cv.type} = ${cv.value}`
      : 'undefined';
    return `<span class="watch-chip" data-name="${esc(name)}">${esc(name)}: ${esc(String(val))}</span>`;
  }).join('');
}

$('#vw-watchlist').addEventListener('click', e => {
  const chip = e.target.closest('.watch-chip');
  if (!chip) return;
  const name = chip.dataset.name;
  if (e.detail >= 2) { toggleWatch(name); return; }
  if (state.ctrl.has(name)) {
    state.varsTab = 'control';
    state.selectedCtrl = name;
  } else {
    state.varsTab = 'iconic';
    state.selectedVar = name;
  }
  $$('#variable-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.varsTab));
  renderVariables();
});

$('#vw-watch').addEventListener('click', () => {
  toggleWatch(state.varsTab === 'control' ? state.selectedCtrl : state.selectedVar);
});
$('#vw-plot').addEventListener('click', () => {
  if (!state.selectedCtrl) { log('Plot: select a control variable first (Control tab).', 'warn'); return; }
  openPlot(state.selectedCtrl);
});
$('#vw-display').addEventListener('click', () => displayIconic(state.selectedVar));
$('#vw-clear').addEventListener('click', () => clearVar(state.selectedVar));
$('#vw-clearall').addEventListener('click', clearAllVars);

function clearVar(name) {
  const rec = state.iconic.get(name);
  if (!rec) return;
  /* a procedure parameter aliases the caller's variable (one record under two
     names), so clearing one clears all of its names */
  const names = [];
  state.iconic.forEach((r, n) => { if (r === rec) names.push(n); });
  names.forEach(n => state.iconic.delete(n));
  if (rec.dispose) rec.dispose();
  GFX.wins.forEach(g => {
    const had = names.includes(g.base) || g.items.some(it => names.includes(it.name));
    if (!had) return;
    if (names.includes(g.base)) g.base = null;
    g.items = g.items.filter(it => !names.includes(it.name));
    renderGraphics(g);
  });
  if (names.includes(state.selectedVar)) state.selectedVar = null;
  log(`Variable cleared: ${names.join(', ')}`, 'msg');
  syncUI();
}
function clearAllVars() {
  setLive(false);
  clearRunState();
  log('All variables cleared.', 'msg');
  syncUI();
  renderGraphics(mainGfx);
}

/* ---------------- live camera mode: grab loop into 'Image' while a frame grabber is open ---------------- */
let liveTimer = null;
function setLive(on) {
  if (on && !liveTimer) {
    if (!opencvReady) { log('Live: OpenCV WASM not ready yet.', 'warn'); return; }
    if (!GRABBERS.size) log('Live: open a frame grabber first (open_framegrabber).', 'warn');
    liveTimer = setInterval(() => {
      const handle = GRABBERS.size ? [...GRABBERS.keys()][0] : null;
      if (handle === null) { setLive(false); return; }
      try {
        const ctx = makeOpCtx();
        ocvGrabHandle(handle, 'Image', ctx);
        ctx.displayImage('Image');
        repaintVarCard('Image');
        renderWatch();
      } catch (err) {
        log('Live grab failed: ' + err.message, 'err');
        setLive(false);
      }
    }, 120);
    log('Live mode started (grab loop).', 'msg');
  } else if (!on && liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
    log('Live mode stopped.', 'msg');
  }
  $$('.gt-btn[data-gcmd="live"]').forEach(b => b.classList.toggle('live-on', !!liveTimer));
}

/* ---------------- keyboard ---------------- */
/* Registered in the *capture* phase on purpose.  Monaco binds some of these keys
   itself — F8 is "go to the next marker" in the VS Code keymap it inherits — and
   the editor calls stopPropagation() for a key it handles, so a bubble-phase
   listener never saw F8 while the program window had focus.  The focus sits in
   the editor between two steps, so F8 (Step Over) did nothing at all for a real
   user.  Handling the key on the way down, and stopping it there, keeps it for
   the debugger.  Escape is left to propagate: the operator input and the folder
   browser use it for their own autocomplete / dialog. */
/* Right Alt (AltGr) arrives as Ctrl+Alt on Windows, so a plain "no modifiers"
   test would drop it and "Ctrl+Alt" alone would swallow left-hand combos.  The
   AltGraph state the platform reports for the right-hand key tells them apart;
   the tracked Alt keydown covers engines that do not report it. */
function altGrNow(e) {
  try { if (e.getModifierState && e.getModifierState('AltGraph')) return true; } catch (err) { /* not a real event */ }
  return altIsRight && e.ctrlKey;
}
let altIsRight = false;   // which Alt is held down (see the Alt+Enter branch)
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  const take = () => { e.preventDefault(); e.stopPropagation(); };
  if (e.key === 'Alt') { altIsRight = e.location === 2 || e.code === 'AltRight'; return; }  // Alt+Enter accepts both sides
  if (mod && (e.key === 'o' || e.key === 'O')) { take(); openProgram(); }
  else if (mod && (e.key === 's' || e.key === 'S')) { take(); e.shiftKey ? saveProgramAs() : saveProgram(); }
  /* HDevelop's "open the sub-procedure".  Monaco cannot give this key to an
     editor action: `addAction({keybindings})` registers a *dynamic* keybinding
     and those are not resolved by this build of the standalone editor (checked
     at runtime — a freshly added action with the same key never fires, while a
     built-in binding like Alt+Up does), so the key is taken here, on the way
     down, before Monaco sees it.  A text field of another window (operator
     input, folder browser, watch expression) keeps Alt+Enter for itself.

     Both Alt keys work.  Right Alt is AltGr, which Windows reports as Ctrl+Alt:
     the Alt keydown above remembers which side it came from (`e.location === 2`,
     which is also what `getModifierState('AltGraph')` says where the platform
     reports it), so the right-hand key is not mistaken for a Ctrl shortcut.
     A left Ctrl+left Alt+Enter stays untouched. */
  else if (e.altKey && e.key === 'Enter' && (!mod || altGrNow(e))) {
    const t = document.activeElement;
    const editable = t && (/^(INPUT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable);
    if (editable && !$('#editor-monaco').contains(t)) return;
    take(); openSubProcedure();
  }
  else if (e.key === 'F5') { take(); e.ctrlKey ? doRunToCursor() : doRun(); }
  else if (e.key === 'F6') { take(); doStep('into'); }   // into a procedure
  else if (e.key === 'F8') { take(); doStep('over'); }   // over a call
  else if (e.key === 'F2') { take(); doReset(); }
  else if (e.key === 'F1') { take(); openOperatorDialog(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeModal(); $$('.menu.open').forEach(m => m.classList.remove('open')); }
}, true);

/* ---------------- resize: handled per graphics window by its own ResizeObserver ---------------- */

/* ==========================================================================
   INIT
   ========================================================================== */
function init() {
  syntheticCanvas = buildChipImage();
  registerImageSource(BUILTIN_IMAGE, syntheticCanvas, true);  // read_image ('printer_chip')
  const restored = loadLayout();
  setFitChecked(mainGfx, true);
  setStatus('Loading OpenCV WASM…');
  refreshProcSelect();
  setProgramFileLabel();
  loadMonaco();                             // the Program Window editor (created once)
  initExtSync();
  waitOpenCV().then(ok => { if (ok) log('OpenCV WASM runtime ready.', 'msg'); });
  log('OpenCVS demo started.', 'msg');
  /* What is loaded here is the built-in demo, not program.ovs — saying
     "program.ovs loaded" was wrong and made a stale procedure table look
     like a file that had been read.  The dev server pushes the real program
     through the external sync, which logs its own "Opened …" line. */
  log(`Demo program loaded (${Object.keys(PROCEDURES).join(', ')}).`, 'msg');
  if (restored) log('Layout restored from previous session.', 'msg');
  log('Press F5 to run, F6 to step into a procedure, F8 to step over it, ' +
      'Alt+Enter to open the procedure a program line calls.', 'msg');
  renderProgram();
  renderOperator();
  renderVariables();
  renderHistory();
  renderTaskbar();
  wireFeatureInspection();
  renderFeatureInspection();
  probePageFolder();
  setFitChecked(mainGfx, true);
  resizeGraphics();
  renderGraphics(mainGfx);
  paintThumbs();
}
init();

/* ==========================================================================
   WINDOW MANAGER — TABBED STACKS (continued): combine / pop-out engine
   ========================================================================== */
const WIN_HOME = {
  'win-program':  { col: 'col-left',   before: 'sp-left-v' },
  'win-operator': { col: 'col-left',   after:  'sp-left-v' },
  'win-graphics': { col: 'col-center', before: 'sp-center-v' },
  'win-history':  { col: 'col-center', after:  'sp-center-v' },
  'win-variable': { col: 'col-right',  before: 'sp-right-v' },
  'win-featureinsp': { col: 'col-right', after: 'sp-right-v' },
};
function wmGoHome(win) {
  const h = WIN_HOME[win.id];
  if (!h) return;
  const col = $('#' + h.col);
  if (h.before) col.insertBefore(win, $('#' + h.before));
  else if (h.after) col.insertBefore(win, $('#' + h.after).nextSibling);
  else col.appendChild(win);
}

function updateSplitters() {
  const inFlow = el => {
    if (!el || (!el.classList.contains('window') && !el.classList.contains('wm-stack'))) return false;
    if (el.classList.contains('hidden-win')) return false;
    return getComputedStyle(el).position !== 'absolute';
  };
  $$('.splitter-h').forEach(sp => {
    const kids = Array.from(sp.parentElement.children);
    const i = kids.indexOf(sp);
    sp.style.display = (inFlow(kids[i - 1]) && inFlow(kids[i + 1])) ? '' : 'none';
  });
}

function wmStackCreate() {
  const id = 'wmstack' + (stackSeq++);
  const el = document.createElement('div');
  el.className = 'wm-stack';
  el.id = id;
  el.innerHTML = '<div class="wm-stack-tabs"></div><div class="wm-stack-body"></div>';
  const grip = document.createElement('div');
  grip.className = 'wm-grip';
  el.appendChild(grip);
  wmWireGrip(el, grip);
  el.addEventListener('pointerdown', () => {
    if (wmRec(id).mode === 'floating' && !el.classList.contains('max')) wmRaise(el);
  });
  /* only the tab bar maximises the group - a double click inside the window
     content (editor!) must not resize the group */
  el.addEventListener('dblclick', e => {
    if (e.target.closest('.wm-stab, .wm-stab-pop, .wbtn')) return;
    if (!e.target.closest('.wm-stack-tabs')) return;
    if (performance.now() - (wmRec(id).dragMoved || 0) < 250) return;
    if (wmRec(id).mode === 'floating') wmToggleMax(el);
  });
  const rec = { id, el, members: [], active: null };
  STACKS.set(id, rec);
  return rec;
}

function wmStackBtn(s, b) {
  if (b.classList.contains('min')) {
    if (wmRec(s.id).mode === 'floating') s.el.classList.add('minimized');
    else s.el.classList.add('min');
    renderTaskbar();
  } else if (b.classList.contains('float')) {
    wmToggleFloat(s.id);
  } else if (b.classList.contains('max')) {
    wmToggleMax(s.el);
  } else if (b.classList.contains('close')) {
    s.el.classList.add('hidden-win');
    log('Tab group closed (reopen via taskbar or Window menu).', 'msg');
    renderTaskbar();
  }
}

function wmAddToStack(s, winId) {
  const win = $('#' + winId);
  win.classList.remove('floating', 'min', 'minimized');
  wmClearInline(win);
  win.classList.add('tabbed');
  if (s.active && s.active !== winId) win.classList.add('inactive');
  s.el.querySelector('.wm-stack-body').appendChild(win);
  if (!s.members.includes(winId)) s.members.push(winId);
  STACK_OF.set(winId, s.id);
  wmRec(winId).mode = 'stacked';
  if (!s.active) s.active = winId;
  renderStackTabs(s);
}

function wmSetActive(s, winId) {
  if (!s || !s.members.includes(winId)) return;
  s.active = winId;
  s.members.forEach(m => $('#' + m).classList.toggle('inactive', m !== winId));
  renderStackTabs(s);
  if (winId === 'win-graphics') resizeGraphics();
}

function renderStackTabs(s) {
  const bar = s.el.querySelector('.wm-stack-tabs');
  const POP_SVG = `<span class="wm-stab-pop" title="Pop out of tab group"><svg viewBox="0 0 12 12"><rect x="1" y="4.5" width="6.5" height="6.5" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M4.5 4.5V1.5H11M11 1.5L7.5 5" fill="none" stroke="currentColor" stroke-width="1.1"/></svg></span>`;
  bar.innerHTML = s.members.map(id =>
    `<button class="wm-stab ${id === s.active ? 'active' : ''}" data-win="${id}">` +
    `<span class="tb-icon win"></span>${$('.title', $('#' + id)).textContent}${POP_SVG}</button>`).join('') +
    `<span class="wm-stack-controls">` +
    `<button class="wbtn min" title="Minimize"></button>` +
    `<button class="wbtn float" title="Float / Dock"><svg viewBox="0 0 12 12"><rect x="1" y="4.5" width="6.5" height="6.5" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M4.5 4.5V1.5H11M11 1.5L7.5 5" fill="none" stroke="currentColor" stroke-width="1.1"/></svg></button>` +
    `<button class="wbtn max" title="Maximize"></button>` +
    `<button class="wbtn close" title="Close"></button></span>`;
  $$('.wm-stab', bar).forEach(tab => {
    tab.addEventListener('pointerdown', ev => {
      ev.stopPropagation();
      const winId = tab.dataset.win;
      try { tab.setPointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
      const sx = ev.clientX, sy = ev.clientY;
      let begun = false;
      const move = e2 => {
        if (!begun && Math.abs(e2.clientX - sx) + Math.abs(e2.clientY - sy) > 4) {
          begun = true;
          beginTabDrag(winId, e2);
        }
      };
      const up = () => {
        tab.removeEventListener('pointermove', move);
        tab.removeEventListener('pointerup', up);
        if (!begun) wmSetActive(s, winId);
      };
      tab.addEventListener('pointermove', move);
      tab.addEventListener('pointerup', up);
    });
    tab.addEventListener('dblclick', ev => {
      ev.stopPropagation();
      wmPopOut(tab.dataset.win);
    });
  });
  $$('.wm-stab-pop', bar).forEach(p =>
    p.addEventListener('click', ev => {
      ev.stopPropagation();
      wmPopOut(p.parentElement.dataset.win);
    }));
  $$('.wm-stack-controls .wbtn', bar).forEach(b =>
    b.addEventListener('click', ev => { ev.stopPropagation(); wmStackBtn(s, b); }));
}

function wmRemoveMember(s, winId) {
  s.members = s.members.filter(m => m !== winId);
  STACK_OF.delete(winId);
  const win = $('#' + winId);
  win.classList.remove('tabbed', 'inactive');
  wmRec(winId).mode = 'docked';
  if (s.members.length <= 1) { wmFinishDissolve(s); return; }
  if (s.active === winId) s.active = s.members[0];
  renderStackTabs(s);
  s.members.forEach(m => $('#' + m).classList.toggle('inactive', m !== s.active));
}

function wmFinishDissolve(s) {
  const last = s.members[0];
  const w = $('#' + last);
  const mode = wmRec(s.id).mode;
  w.classList.remove('tabbed', 'inactive');
  if (mode === 'docked') {
    w.style.flex = s.el.style.flex;
    w.style.flexBasis = s.el.style.flexBasis;
    s.el.parentElement.insertBefore(w, s.el);
    wmRec(last).mode = 'docked';
  } else {
    wmRow().appendChild(w);
    w.classList.add('floating');
    const r = s.el.getBoundingClientRect(), row = wmRow().getBoundingClientRect();
    wmApplyRect(w, { x: r.left - row.left, y: r.top - row.top, w: r.width, h: r.height });
    wmRec(last).mode = 'floating';
  }
  STACKS.delete(s.id);
  STACK_OF.delete(last);
  s.el.remove();
}

function wmPopOut(winId, at) {
  const s = STACKS.get(STACK_OF.get(winId));
  if (!s) return;
  const win = $('#' + winId);
  const sr = s.el.getBoundingClientRect();
  const row = wmRow().getBoundingClientRect();
  wmRemoveMember(s, winId);
  wmRow().appendChild(win);
  win.classList.add('floating');
  const x = Math.min(Math.max(0, at ? at.x : sr.left - row.left + 24), row.width - 90);
  const y = Math.min(Math.max(0, at ? at.y : sr.top - row.top + 24), row.height - 30);
  wmApplyRect(win, { x, y, w: Math.max(240, sr.width), h: Math.max(160, sr.height) });
  wmRec(winId).mode = 'floating';
  wmRaise(win);
  updateSplitters();
  renderTaskbar();
  scheduleSave();
  log(`${$('.title', win).textContent} popped out of tab group.`, 'msg');
}

function beginTabDrag(winId, e) {
  const row = wmRow().getBoundingClientRect();
  wmPopOut(winId, { x: e.clientX - row.left - 70, y: e.clientY - row.top - 14 });
  startManagedDrag($('#' + winId), winId, e);
}

function wmCombine(draggedId, targetEl) {
  let s;
  if (targetEl.classList.contains('wm-stack')) {
    s = STACKS.get(targetEl.id);
  } else {
    s = wmStackCreate();
    const tId = targetEl.id;
    if (wmRec(tId).mode === 'floating') {
      wmRow().appendChild(s.el);
      s.el.classList.add('floating');
      wmApplyRect(s.el, wmRect(tId));
      wmRec(s.id).mode = 'floating';
    } else {
      targetEl.parentElement.insertBefore(s.el, targetEl);
      s.el.style.flex = targetEl.style.flex;
      s.el.style.flexBasis = targetEl.style.flexBasis;
      wmRec(s.id).mode = 'docked';
    }
    wmAddToStack(s, tId);
  }
  const dEl = $('#' + draggedId);
  let last;
  if (dEl.classList.contains('wm-stack')) {
    const ds = STACKS.get(draggedId);
    last = ds.members[ds.members.length - 1];
    [...ds.members].forEach(m => wmAddToStack(s, m));
    STACKS.delete(ds.id);
    dEl.remove();
  } else {
    last = draggedId;
    wmAddToStack(s, draggedId);
  }
  wmSetActive(s, last);
  updateSplitters();
  renderTaskbar();
  scheduleSave();
  log(`${s.members.length} windows combined into a tab group.`, 'msg');
}

function computeCombineTarget(el, cx, cy) {
  el.style.pointerEvents = 'none';
  const hit = document.elementFromPoint(cx, cy);
  el.style.pointerEvents = '';
  if (!hit) return null;
  const t = hit.closest('.wm-stack') || hit.closest('.window');
  if (!t || t === el) return null;
  if (t.classList.contains('gfx-win')) return null;   // spawned graphics windows never join tab groups
  if (t.classList.contains('hidden-win') || t.classList.contains('minimized')) return null;
  if (STACK_OF.has(t.id)) return null;          // tabbed member, not a top-level target
  const r = t.getBoundingClientRect();
  if (cy > r.top + 28) return null;             // must hover the title/tab band
  return t;
}

function startManagedDrag(el, id, e) {
  if (e.target.closest('.wbtn, .wm-stab, .wm-stab-pop, .wm-stack-controls')) return;
  if (el.classList.contains('max')) return;
  const rec = wmRec(id);
  wmRaise(el);
  try { el.setPointerCapture(e.pointerId); } catch (err) { /* no active pointer */ }
  const start = { x: e.clientX, y: e.clientY };
  let rc = wmRect(id);
  let floated = rec.mode !== 'docked';
  let moved = false, target = null;
  const move = ev => {
    const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
    if (!floated && Math.abs(dx) + Math.abs(dy) > 3) {
      floated = true;
      wmFloat(id);
      rc = wmRect(id);
    }
    if (!floated) return;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    const row = wmRow().getBoundingClientRect();
    el.style.left = Math.min(Math.max(rc.x + dx, 80 - rc.w), row.width - 80) + 'px';
    el.style.top = Math.min(Math.max(rc.y + dy, 0), row.height - 24) + 'px';
    const t = computeCombineTarget(el, ev.clientX, ev.clientY);
    if (t !== target) {
      target?.classList.remove('wm-drop-combine');
      t?.classList.add('wm-drop-combine');
      target = t;
    }
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    target?.classList.remove('wm-drop-combine');
    if (target && moved) wmCombine(id, target);
    else if (moved) rec.dragMoved = performance.now();
    updateSplitters();
    renderTaskbar();
    scheduleSave();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}
