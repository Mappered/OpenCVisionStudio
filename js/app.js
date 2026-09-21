'use strict';
/* ==========================================================================
   OpenCVisionStudio (OpenCVS) — Machine Vision IDE (Dark Mode) — application logic
   ========================================================================== */

/* ------------------------------ helpers ------------------------------ */
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
             ['MinGray', 'input', 'control'], ['MaxGray', 'input', 'control']],
    desc: 'Segments a region of gray values <code>MinGray</code> &hellip; <code>MaxGray</code>.',
  },
  connection: {
    params: [['Region', 'input', 'iconic'], ['ConnectedRegions', 'output', 'iconic']],
    desc: 'Computes the connected components of a region.',
  },
  select_shape: {
    params: [['Regions', 'input', 'iconic'], ['SelectedRegions', 'output', 'iconic'],
             ['Features', 'input', 'control'], ['Operation', 'input', 'control'],
             ['Min', 'input', 'control'], ['Max', 'input', 'control']],
    desc: 'Selects regions with the given shape feature (here: <code>area</code>).',
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
  stop:     { params: [], desc: 'Stops program execution.' },
  return:   { params: [], desc: 'Returns from the current procedure.' },
  if:       { params: [['Condition', 'input', 'control']], desc: 'Conditional statement.' },
  endif:    { params: [], desc: 'End of conditional statement.' },
};
Object.assign(OPINFO, METROLOGY_OPINFO);

/* Entering an operator writes its call the way HDevelop does: parameters with a
   documented default are filled in with it, the remaining ones are written as
   placeholders (their name) and the caret is placed on the first of them, so
   Tab/Enter steps through the arguments that still have to be chosen. */
function opInsertEntries(op) {
  const info = OPINFO[op];
  if (!info) return [];
  return info.params.map(p => ({
    name: p[0],
    txt: p.length > 3 ? String(p[3]) : p[0],
    placeholder: p.length <= 3,
  }));
}

/* argument text plus the offset of every argument inside it */
function opArgText(op) {
  const entries = opInsertEntries(op);
  let off = 0;
  const starts = entries.map(e => { const s = off; off += e.txt.length + 2; return s; });
  return { entries, starts, text: entries.map(e => e.txt).join(', ') };
}

/* ------------------------------ global state ------------------------------ */
const state = {
  proc: 'main',
  cursor: 1,          // selected line (1-based)
  pc: null,           // program counter line (1-based) or null
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
  editorKind: 'classic',      // 'classic' | 'monaco' (VS Code editor)
  watch: new Set(),           // watched variable names (persist across runs)
  plotVar: null,              // control variable shown in the plot panel
  updateWindow: true,         // dev_update_window: display operator results automatically
  unknownOps: new Set(),      // operators reported as not implemented (once per name)
  errorLine: null,            // { proc, line, text } of the line that stopped the run
  progFile: 'program.odev',   // file name of the current program (Open/Save Program)
};

/* HALCON control-flow keywords and statements: not operators, never reported
   as "not implemented". */
const HD_KEYWORDS = new Set(['if', 'else', 'elseif', 'endif', 'for', 'endfor', 'while', 'endwhile',
  'repeat', 'until', 'break', 'continue', 'return', 'stop', 'exit', 'try', 'catch', 'endtry',
  'switch', 'case', 'endswitch', 'default', 'global', 'throw', 'assert', 'comment']);

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
  const word = t.split(/[\s(]/, 1)[0];
  const hasParen = t.indexOf('(') >= 0;
  if (HD_KEYWORDS.has(word) && !hasParen) return null;      // bare keyword / alternate syntax
  const head = word.length > 24 ? `${word.slice(0, 24)}…` : word;
  return hasParen ? "no closing ')'"
                  : `'${head}' is not an operator call`;
}

const isExecutable = t => parseLine(t) !== null || lineProblem(t) !== null;

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
  state.history.push({ t: now(), kind: kind || 'msg', text });
  renderHistory();
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
function highlight(text) {
  if (isComment(text)) return `<span class="tok-comment">${esc(text)}</span>`;
  const re = /('[^']*')|(\b\d+(\.\d+)?\b)|(\b(if|elseif|else|endif|for|endfor|while|endwhile|try|catch|endtry|return|exit|stop)\b)|([A-Za-z_][A-Za-z0-9_]*)(?=\s*\()/g;
  let out = '', last = 0, m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    if (m[1]) out += `<span class="tok-string">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-number">${m[2]}</span>`;
    else if (m[4]) out += `<span class="tok-kw">${m[4]}</span>`;
    else if (m[6]) out += isDisplayOp(m[6])
      ? `<span class="tok-dev">${esc(m[6])}</span>`
      : `<span class="tok-op">${esc(m[6])}</span>`;
    last = re.lastIndex;
  }
  out += esc(text.slice(last));
  return out;
}

function renderProgram() {
  if (state.editorKind === 'monaco') {         // Monaco holds the text; refresh decorations only
    if (monacoEditor) monacoRefreshDecorations();
    return;
  }
  const L = linesOf(state.proc);
  $('#editor-gutter').innerHTML = L.map((_, i) => {
    const n = i + 1, key = `${state.proc}:${n}`;
    const e = state.errorLine;                    // marker of the line that stopped the run
    const bad = !!e && e.proc === state.proc && e.line === n && L[i] === e.text;
    return `<div class="gl ${state.cursor === n ? 'cursor' : ''} ${state.pc === n ? 'current' : ''}${bad ? ' error' : ''}" data-bp="${key}"` +
      `${bad ? ' title="The processor stopped on this line"' : ''}>` +
      (state.breakpoints.has(key) ? '<span class="bp-dot"></span>' : '') +
      (state.pc === n ? '<span class="pc-arrow">&#9654;</span>' : '') +
      (bad && state.pc !== n ? '<span class="err-mark">&#10006;</span>' : '') +
      `${n}</div>`;
  }).join('');
  $('#editor-highlight').innerHTML = L.map(highlight).join('\n');
}

/* ---------------- operator window ---------------- */
function renderOperator() {
  const body = $('#operator-body');
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
      const valHtml = isIconic
        ? `<span class="pval iconic">${iconicThumb(val)}<span>${esc(val)}</span></span>`
        : `<span class="pval${missing && def ? ' def' : ''}"` +
          `${missing && def ? ' title="default — the program line passes no argument here"' : ''}>` +
          `${esc(missing && def ? def : val)}</span>`;
      return `<div class="op-row"><span class="dir ${dir === 'input' ? 'in' : 'out'}">${dir === 'input' ? '&#9654;' : '&#9664;'}</span>` +
             `<span class="pname">${r.p[0]}</span>${valHtml}` +
             `<span class="pkind">${r.p[2]}</span></div>`;
    }).join('') + '</div>';
  };
  body.innerHTML = html + imageSourceBar(parsed) +
    section('Input parameters', 'input') + section('Output parameters', 'output');
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
function imageFileParamIndex(op) {
  const info = OPINFO[op];
  return info ? info.params.findIndex(p => p[0] === IMAGE_FILE_PARAM) : -1;
}

/* bar above the parameter list of an operator with a file parameter: every
   image file available in this session (the built-in demo image plus the files
   loaded from disk) and the button that picks a new one */
function imageSourceBar(parsed) {
  const idx = imageFileParamIndex(parsed.op);
  if (idx < 0) return '';
  const cur = imageArgName(parsed.args[idx]);
  const known = IMAGE_SOURCES.get(cur);
  const opts = [];
  if (cur && !known) opts.push(`<option value="${esc(cur)}" selected>${esc(cur)} — not loaded</option>`);
  for (const rec of IMAGE_SOURCES.values()) {
    opts.push(`<option value="${esc(rec.name)}"${rec.name === cur ? ' selected' : ''}>` +
      `${esc(rec.name)}${rec.builtin ? ' (demo)' : ` (${rec.w}×${rec.h})`}</option>`);
  }
  return `<div class="op-filebar"><span class="fb-label">Image file</span>` +
    `<select id="op-imgsrc" title="Image file that the ${esc(IMAGE_FILE_PARAM)} parameter refers to">` +
    `${opts.join('')}</select>` +
    `<button class="op-btn" data-loadimg title="Read an image file from disk (PNG, JPG, BMP, GIF, TIFF, WebP)">` +
    `Load file…</button></div>`;
}

/* file picker -> read_image */
function openImageFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,.png,.jpg,.jpeg,.bmp,.gif,.webp,.tif,.tiff,.pgm,.ppm';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.remove();
    if (f) readImageFile(f);
  });
  input.click();
}

/* decode a picked file and keep it as an image source under its own name */
function readImageFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    registerImageSource(file.name, canvas, false);
    log(`Loaded image file '${file.name}' (${canvas.width}×${canvas.height}` +
      (scale < 1 ? `, scaled down from ${w}×${h}` : '') + ').', 'msg');
    setImageSource(file.name);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    log(`Load file: '${file.name}' could not be decoded as an image.`, 'err');
  };
  img.src = url;
}

/* Point FileName of the read_image line at the cursor at `name` and read the
   image at once, so an uploaded file shows up in the graphics window. */
function setImageSource(name) {
  const n = state.cursor;
  const text = lineText(state.proc, n) || '';
  const parsed = parseLine(text);
  const idx = parsed ? imageFileParamIndex(parsed.op) : -1;
  if (idx < 0) {
    log(`Load file: line ${n} is not a read_image — '${name}' is kept for the next ` +
        `read_image call.`, 'warn');
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

/* both controls live in the Operator Window body, which is re-rendered often */
$('#operator-body').addEventListener('click', e => {
  if (e.target.closest('[data-loadimg]')) openImageFile();
});
$('#operator-body').addEventListener('change', e => {
  if (e.target.id === 'op-imgsrc') setImageSource(e.target.value);
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

function paintIconic(rec, x, w, h) {
  if (rec && rec.canvas) x.drawImage(rec.canvas, 0, 0, w, h);
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
  if (rec.canvas) g2.drawImage(rec.canvas, 0, 0);
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
function gfxResetPart(G) {
  G.part = null;
  if (fitChecked(G)) fitView(G);
  else { G.view.scale = 1; G.view.ox = 0; G.view.oy = 0; }
}
function gfxShowImage(G, name) {          // display of a full image -> clears the history
  const rec = state.iconic.get(name);
  const prev = G.base && state.iconic.get(G.base);
  G.base = name;
  G.items.length = 0;
  if (rec && rec.canvas && (!prev || !prev.canvas ||
      prev.canvas.width !== rec.canvas.width || prev.canvas.height !== rec.canvas.height)) gfxResetPart(G);
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
  const rec = G.base && state.iconic.get(G.base);
  const W = (rec && rec.canvas && rec.canvas.width) || IMG_W;
  const H = (rec && rec.canvas && rec.canvas.height) || IMG_H;
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

function fitView(G) {
  const r = G.wrap.getBoundingClientRect();
  if (r.width < 20 || r.height < 20) return;
  const s = Math.min(r.width / IMG_W, r.height / IMG_H) * 0.98;
  G.view.scale = s;
  G.view.ox = (r.width - IMG_W * s) / 2;
  G.view.oy = (r.height - IMG_H * s) / 2;
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
  el.textContent = (rec && rec.canvas) ? `${rec.canvas.width} × ${rec.canvas.height}` : '—';
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
  if (baseRec && baseRec.canvas) g2.drawImage(baseRec.canvas, 0, 0);
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
  if (!rec || x < 0 || y < 0 || x >= IMG_W || y >= IMG_H) return null;
  return rec.gray[((y | 0) * IMG_W) + (x | 0)];
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
    const hint = $('.gtools-hint', el);
    if (hint) hint.textContent = G.tool === 'profile' ? 'Drag a line in the image' : '';
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
      const old = state.iconic.get(name);
      if (old && old.dispose) old.dispose();       // free previous cv.Mat (e.g. grab loops)
      state.iconic.set(name, rec);
      if (state.selectedVar === null) state.selectedVar = name;
      touched.push(name);
    },
    defCtrl(name, value, type) { state.ctrl.set(name, { value, type }); },
    ctrl(name) { const v = state.ctrl.get(name); return v ? v.value : undefined; },
    displayImage(name) { gfxShowImage(gfxActive(), name); },
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

async function execute(proc, n) {        // execute line n of proc; false = stop
  const text = lineText(proc, n);
  const p = parseLine(text);
  if (!p) {
    const problem = lineProblem(text);
    if (!problem) return true;                    // blank line, comment, bare keyword
    haltLine(proc, n, text, null, problem);       // invalid line: report and stop
    syncUI();
    return false;
  }
  log(text.trim(), 'cmd');

  let cont = true;
  const impl = OP_IMPLS[p.op];
  if (impl) {
    if (!opencvReady && !(await waitOpenCV())) return false;
    const ctx = makeOpCtx();
    try {
      await impl(p.args, ctx);
      if (state.updateWindow) ctx.autoDisplayResults();   // dev_update_window ('on')
    } catch (err) {
      haltLine(proc, n, text, p.op, err && err.message ? err.message : String(err));
      cont = false;
    }
  } else {
    switch (p.op) {
      case 'if': {
        const num = state.ctrl.get('Number');
        log(`Condition "${p.args[0]}" is ${num && num.value > 0 ? 'true' : 'false'}.`);
        break;
      }
      case 'return':
        log(`Returned from ${proc}.`);
        break;
      case 'stop':
        cont = false;
        break;
      default:
        /* HDevelop refuses to run an operator it does not know; this build
           stops on it as well instead of skipping the line and going on. */
        if (!HD_KEYWORDS.has(p.op)) {
          state.unknownOps.add(p.op);
          haltLine(proc, n, text, p.op, 'not implemented in this build');
          cont = false;
        }
        break;
    }
  }
  syncUI();
  return cont;
}

function syncUI() {
  renderProgram();
  renderVariables();
  renderOperator();
  paintThumbs();
  renderWatch();
  GFX.wins.forEach(g => drawPlot(g));
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
  state.iconic.forEach(rec => rec.dispose && rec.dispose());
  state.iconic.clear();
  state.ctrl.clear();
  state.selectedVar = null;
  state.selectedCtrl = null;
  state.unknownOps.clear();
  state.errorLine = null;                        // the red marker of the last failure
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

function doReset() {
  state.running = false;
  state.stopRequested = false;
  setLive(false);
  clearRunState();
  state.pc = null;
  syncUI();
  renderGraphics(mainGfx);
  log('Program reset.');
  setStatus('Ready');
}

async function doRun() {
  if (state.running) return;
  if (state.pc === null) {
    clearRunState();
    state.pc = firstExecutable(state.proc);
  }
  state.running = true; state.stopRequested = false;
  setStatus('Running…', true);
  while (state.pc !== null && state.running && !state.stopRequested) {
    const n = state.pc;
    renderProgram();
    const cont = await execute(state.proc, n);
    if (!cont) { state.pc = null; break; }
    if (state.stopRequested) break;
    state.pc = nextExecutable(state.proc, n);
  }
  state.running = false;
  if (state.stopRequested) { log('Execution stopped by user.', 'warn'); setStatus('Stopped'); }
  else if (state.errorLine) { log(`Program aborted at line ${state.errorLine.line}.`, 'err'); setStatus(`Error at line ${state.errorLine.line}`); }
  else { log('Program stopped (stop).', 'msg'); setStatus('Ready'); }
  state.stopRequested = false;
  syncUI();
}

async function doStep() {
  if (state.running) return;
  if (state.pc === null) {
    clearRunState();
    state.pc = firstExecutable(state.proc);
    syncUI();
    return;
  }
  const n = state.pc;
  setStatus(`Step: line ${n}`, true);
  const cont = await execute(state.proc, n);
  state.pc = cont ? nextExecutable(state.proc, n) : null;
  setStatus(state.errorLine ? `Error at line ${state.errorLine.line}`
    : state.pc ? `Stopped at line ${state.pc}` : 'Ready');
  syncUI();
}

async function doRunToCursor() {
  const target = state.cursor;
  if (state.running) return;
  if (state.pc === null) { clearRunState(); state.pc = firstExecutable(state.proc); }
  state.running = true; state.stopRequested = false;
  setStatus('Running to cursor…', true);
  while (state.pc !== null && state.pc !== target && !state.stopRequested) {
    const n = state.pc;
    renderProgram();
    if (!(await execute(state.proc, n))) break;
    state.pc = nextExecutable(state.proc, n);
  }
  state.running = false;
  setStatus(state.errorLine ? `Error at line ${state.errorLine.line}`
    : state.pc ? `Stopped at line ${state.pc}` : 'Ready');
  syncUI();
}

function doStop() { if (state.running) state.stopRequested = true; }

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
   MODAL
   ========================================================================== */
function showModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal-overlay').classList.remove('hidden');
}
function closeModal() {
  $('#modal-overlay').classList.add('hidden');
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
  run: doRun, runtocursor: doRunToCursor, step: doStep, stepover: doStep,
  stop: doStop, reset: doReset,
  new()  { newProgram(); },
  open() { openProgram(); },
  save() { saveProgram(); },
  saveas() { saveProgramAs(); },
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
const WIN_IDS = { program: 'win-program', operator: 'win-operator', graphics: 'win-graphics', variable: 'win-variable', history: 'win-history' };
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
  bar.innerHTML = ids.map(id => {
    const win = $('#' + id);
    const vis = winVisible(win);
    return `<button class="wm-task-btn ${vis ? 'visible' : ''}" data-winid="${id}">` +
           `<span class="tb-icon win"></span><span class="wm-task-label">${$('.title', win).textContent}</span></button>`;
  }).join('');
  $$('.wm-task-btn', bar).forEach(b =>
    b.addEventListener('click', () => wmTaskbarToggle(b.dataset.winid)));
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
  ['col-left', 'col-right'].forEach(id => { $('#' + id).style.flexBasis = ''; });
  $('#win-program').style.flexBasis = '';
  $('#win-history').style.flexBasis = '';
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
      },
      breakpoints: [...state.breakpoints],
      proc: state.proc,
      editorKind: state.editorKind,
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
  if (L.editorKind === 'monaco' || L.editorKind === 'classic') {
    state.editorKind = L.editorKind;
    $('#editor-kind').value = L.editorKind;
  }
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
$$('.splitter').forEach(sp => {
  sp.addEventListener('pointerdown', e => {
    e.preventDefault();
    sp.classList.add('dragging');
    sp.setPointerCapture(e.pointerId);
    const kind = sp.dataset.split;
    const start = { x: e.clientX, y: e.clientY };
    const left = $('#col-left'), right = $('#col-right');
    const prog = $('#win-program'), hist = $('#win-history');
    const l0 = left.getBoundingClientRect().width;
    const r0 = right.getBoundingClientRect().width;
    const p0 = prog.getBoundingClientRect().height;
    const h0 = hist.getBoundingClientRect().height;
    const move = ev => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (kind === 'left')       left.style.flexBasis  = Math.min(700, Math.max(220, l0 + dx)) + 'px';
      if (kind === 'right')      right.style.flexBasis = Math.min(500, Math.max(180, r0 - dx)) + 'px';
      if (kind === 'left-v')     prog.style.flexBasis  = Math.min(600, Math.max(120, p0 + dy)) + 'px';
      if (kind === 'center-v')   hist.style.flexBasis  = Math.min(400, Math.max(90,  h0 - dy)) + 'px';
      resizeGraphics();
    };
    const up = () => {
      sp.classList.remove('dragging');
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', up);
      scheduleSave();
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
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
/* The editor is a transparent textarea over a syntax-highlighted pre: native
   caret, selection, copy/paste, undo. The gutter holds breakpoints/pc arrow. */
const edInput = $('#editor-input');

function editorLoad() {
  if (state.editorKind === 'monaco' && monacoEditor) {
    monacoApplyGuard = true;
    monacoEditor.setValue(linesOf(state.proc).join('\n'));
    monacoApplyGuard = false;
    monacoEditor.setPosition({ lineNumber: 1, column: 1 });
    monacoRefreshDecorations();
  } else {
    edInput.value = linesOf(state.proc).join('\n');
  }
  renderProgram();
}

function edCaretLine() {
  return edInput.value.slice(0, edInput.selectionStart || 0).split('\n').length;
}

function edEnsureVisible() {
  const gl = $$('#editor-gutter .gl')[edCaretLine() - 1];
  if (!gl) return;
  const code = $('#program-code');
  const top = gl.offsetTop, h = code.clientHeight || 400;
  if (top < code.scrollTop + 8 || top > code.scrollTop + h - 30) {
    code.scrollTop = Math.max(0, top - h / 3);
  }
}

/* caret position drives the selected line (operator window + status bar follow) */
function edSyncCursor() {
  const pos = edInput.selectionStart || 0;
  const lineStart = edInput.value.lastIndexOf('\n', pos - 1) + 1;
  const line = edCaretLine();
  if (line !== state.cursor) {
    state.cursor = line;
    renderProgram();
    renderOperator();
  }
  $('#status-line').textContent = `Line: ${line}, Col: ${pos - lineStart + 1}`;
  edEnsureVisible();
}

function edFocusLine(n) {
  const L = linesOf(state.proc);
  const line = Math.max(1, Math.min(n, L.length));
  state.cursor = line;
  if (state.editorKind === 'monaco' && monacoEditor) {
    monacoEditor.setPosition({ lineNumber: line, column: 1 });
    monacoEditor.revealLineInCenterIfOutsideViewport(line);
    monacoEditor.focus();
  } else {
    let pos = 0;
    for (let i = 0; i < line - 1; i++) pos += L[i].length + 1;
    edInput.value = L.join('\n');
    edInput.focus();
    edInput.setSelectionRange(pos, pos);
    const gl = $$('#editor-gutter .gl')[line - 1];
    if (gl) $('#program-code').scrollTop = Math.max(0, gl.offsetTop - 40);
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
  if (state.pc > first) state.pc = first;   // edited line is above it -> move up to it
  if (state.pc > nextLines.length) state.pc = Math.max(1, nextLines.length);
}

edInput.addEventListener('input', () => {
  const prev = PROCEDURES[state.proc].lines.slice();
  const next = edInput.value.split('\n');
  PROCEDURES[state.proc].lines = next;
  edEditAnchor(prev, next);
  if (edInput.scrollTop) edInput.scrollTop = 0;    // overlay stays aligned; #program-code scrolls
  renderProgram();
  renderVariables();
  renderOperator();
  paintThumbs();
  $('#proc-modified').style.visibility = 'visible';
  scheduleSave();
  edSyncCursor();
});
edInput.addEventListener('keyup', edSyncCursor);
edInput.addEventListener('click', () => {
  if (edInput.scrollTop) edInput.scrollTop = 0;
  edSyncCursor();
});
edInput.addEventListener('keydown', e => {
  if (e.key === 'Tab') {                                   // indent with spaces
    e.preventDefault();
    edInput.setRangeText('    ', edInput.selectionStart, edInput.selectionEnd, 'end');
    edInput.dispatchEvent(new Event('input'));
  } else if (e.key === 'Enter') {                          // auto-indent: carry leading whitespace
    e.preventDefault();
    const pos = edInput.selectionStart;
    const lineStart = edInput.value.lastIndexOf('\n', pos - 1) + 1;
    const indent = (edInput.value.slice(lineStart, pos).match(/^\s*/) || [''])[0];
    edInput.setRangeText('\n' + indent, edInput.selectionStart, edInput.selectionEnd, 'end');
    edInput.dispatchEvent(new Event('input'));
  }
});

/* gutter click toggles the breakpoint */
function toggleBp(key) {
  state.breakpoints.has(key) ? state.breakpoints.delete(key) : state.breakpoints.add(key);
  renderProgram();
  scheduleSave();
}
$('#editor-gutter').addEventListener('click', e => {
  const gl = e.target.closest('.gl');
  if (gl) toggleBp(gl.dataset.bp);
});

/* ---------------- VS Code editor (Monaco), vendored under vendor/monaco ---------------- */
/* Loaded lazily on first use; the classic textarea editor remains the fallback. */
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
  try { monacoApplyDecorations(); } finally { monacoDecGuard = false; }
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
  if (state.pc !== null && state.pc <= linesOf(state.proc).length) {
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
        for (const [name, info] of Object.entries(OPINFO)) {
          /* like the autocomplete: HDevelop's defaults as snippet text, the
             remaining parameters as Tab stops (${1:Name}) */
          const entries = opInsertEntries(name);
          items.push({
            label: name,
            kind: isDisplayOp(name)
              ? m.languages.CompletionItemKind.Function : m.languages.CompletionItemKind.Method,
            detail: `${name} ( ${info.params.map(p => p[0]).join(', ')} )`,
            insertText: `${name} ( ${entries.map((e, i) => '${' + (i + 1) + ':' + e.txt + '}').join(', ')} )`,
            insertTextRules: m.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          });
        }
      }
      return { suggestions: items };
    },
  });
  monacoRefreshDecorations();
}

async function setEditorKind(kind, save = true) {
  if (kind === 'monaco') {
    if (!monacoEditor) {
      setStatus('Loading VS Code editor…');
      const m = await monacoReady();
      if (!m) {
        log('VS Code editor (Monaco) failed to load — using the classic editor.', 'err');
        kind = 'classic';
      } else {
        setupMonaco(m);
      }
    }
    if (monacoEditor) {
      state.editorKind = 'monaco';
      monacoApplyGuard = true;
      const pos = monacoEditor.getPosition();
      monacoEditor.setValue(linesOf(state.proc).join('\n'));
      monacoApplyGuard = false;
      const nLines = linesOf(state.proc).length;
      monacoEditor.setPosition(pos && pos.lineNumber <= nLines
        ? pos : { lineNumber: Math.min(state.cursor, nLines), column: 1 });
      monacoEditor.focus();
    }
  } else {
    state.editorKind = 'classic';
    edInput.value = linesOf(state.proc).join('\n');   // pull any Monaco edits back
  }
  const useMonaco = state.editorKind === 'monaco';
  $('#editor-classic').classList.toggle('hidden', useMonaco);
  $('#editor-monaco').classList.toggle('hidden', !useMonaco);
  $('#editor-kind').value = state.editorKind;
  renderProgram();
  renderOperator();
  setStatus('Ready');
  if (save) scheduleSave();
}
$('#editor-kind').addEventListener('change', e => setEditorKind(e.target.value));

/* ---------------- program files: Open / Save (.odev, .hdev) ----------------
   A program is one text file holding every procedure, each introduced by a
   `* procedure: <name>` line — the same format as program.ovs, so a file saved
   here stays editable in an external editor and in the dev server's live sync.
   Saving defaults to `.odev`. HDevelop `.hdev` files are read as well
   (`procedure <name> (...)` … `endprocedure` blocks, plus the main program
   before the first procedure); a bare operator list loads as `main`. */
const PROGRAM_ACCEPT = '.odev,.hdev,text/plain';
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
    text: names.map(n => `* procedure: ${n}\n${PROCEDURES[n].lines.join('\n')}`).join('\n') + '\n',
    dropped,
  };
}

function parseProgram(text) {
  const trim = a => { const b = a.slice(); while (b.length && !b[b.length - 1].trim()) b.pop(); return b; };
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const procs = {};
  if (lines.some(l => /^\s*\*\s*procedure\s*:/i.test(l))) {           // OpenCVS program format
    let cur = null;
    for (const l of lines) {
      const m = l.match(/^\s*\*\s*procedure\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/i);
      if (m) { cur = m[1]; if (!procs[cur]) procs[cur] = []; continue; }
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
  for (const k of Object.keys(procs)) procs[k] = trim(procs[k]);
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

/* replace the whole program with the contents of a file */
function loadProgram(text, fileName) {
  const procs = parseProgram(text);
  const names = Object.keys(procs);
  if (!names.length || !names.some(n => procs[n].length)) {
    log(`Open Program: '${fileName}' contains no program text.`, 'err');
    return false;
  }
  for (const k of Object.keys(PROCEDURES)) delete PROCEDURES[k];
  for (const n of names) PROCEDURES[n] = { lines: procs[n] };
  state.proc = names.includes('main') ? 'main' : names[0];
  state.progFile = fileName || state.progFile;
  resetProgramState();
  refreshProcSelect();
  setProgramFileLabel();
  $('#proc-modified').style.visibility = 'hidden';
  setStatus('Ready');
  log(`Opened '${fileName}' — ${names.length} procedure(s): ${names.join(', ')}.`, 'msg');
  pushProgramToServer();
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
const extSync = { active: false, applying: false };
let pushTimer = null;

function applyExternalProgram(procs, msg) {
  extSync.applying = true;
  let changed = false;
  for (const [name, lines] of Object.entries(procs)) {
    if (!PROCEDURES[name] || !Array.isArray(lines)) continue;
    PROCEDURES[name].lines = lines.slice();
    changed = true;
  }
  if (changed) {
    state.pc = null;
    editorLoad();
    renderVariables();
    renderOperator();
    log(msg, 'msg');
  }
  extSync.applying = false;
}

function pushProgramToServer() {
  if (!extSync.active || extSync.applying) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    fetch('/api/program', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        procs: Object.fromEntries(Object.entries(PROCEDURES).map(([k, v]) => [k, v.lines])),
      }),
    }).catch(() => {});
  }, 250);
}

async function initExtSync() {
  try {
    const r = await fetch('/api/program');
    if (!r.ok) return;                       // not served by tools/serve.js
    extSync.active = true;
    const data = await r.json();
    if (data.procs && Object.keys(data.procs).length) {
      applyExternalProgram(data.procs, 'Program loaded from program.ovs (external editor sync active).');
    } else {
      pushProgramToServer();                 // first run: seed the file from the editor content
    }
    const es = new EventSource('/events');
    es.onmessage = ev => {
      try {
        const d = JSON.parse(ev.data);
        if (d.kind === 'program') {
          applyExternalProgram(d.procs, 'program.ovs changed on disk - program reloaded.');
        }
      } catch (e) { /* ignore malformed events */ }
    };
    log('External editor sync active (program.ovs).', 'msg');
  } catch (e) { /* no dev server: local single-page mode */ }
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
          const { entries, starts, text } = opArgText(name);
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
  if (!text) return;
  if (state.editorKind === 'monaco' && monacoEditor) {
    const line = Math.min(monacoEditor.getPosition()?.lineNumber || state.cursor, linesOf(state.proc).length);
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
    return;
  }
  const pos = edInput.selectionStart ?? edInput.value.length;
  const lineStart = edInput.value.lastIndexOf('\n', pos - 1) + 1;
  const at = edInput.value.slice(0, lineStart).split('\n').length - 1;   // insert before the caret line
  const L = PROCEDURES[state.proc].lines;
  L.splice(at, 0, text);
  edInput.value = L.join('\n');
  state.cursor = at + 1;
  opInput.value = '';
  peditMode.textContent = '';
  edInput.focus();
  edInput.setSelectionRange(lineStart + text.length, lineStart + text.length);
  $('#proc-modified').style.visibility = 'visible';
  renderProgram();
  renderOperator();
  paintThumbs();
  renderVariables();
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
  state.proc = e.target.value;
  state.pc = null;
  state.cursor = 1;
  $('#status-proc').textContent = `Procedure: ${state.proc}`;
  $('#status-line').textContent = 'Line: 1, Col: 1';
  editorLoad();
  renderOperator();
  renderVariables();
  renderWatch();
  scheduleSave();
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
  rec.dispose && rec.dispose();
  state.iconic.delete(name);
  GFX.wins.forEach(g => {
    const had = g.base === name || g.items.some(it => it.name === name);
    if (!had) return;
    if (g.base === name) g.base = null;
    g.items = g.items.filter(it => it.name !== name);
    renderGraphics(g);
  });
  if (state.selectedVar === name) state.selectedVar = null;
  log(`Variable cleared: ${name}`, 'msg');
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
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); openProgram(); }
  else if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); e.shiftKey ? saveProgramAs() : saveProgram(); }
  else if (e.key === 'F5') { e.preventDefault(); e.ctrlKey ? doRunToCursor() : doRun(); }
  else if (e.key === 'F6') { e.preventDefault(); doStep(); }
  else if (e.key === 'F8') { e.preventDefault(); doStep(); }
  else if (e.key === 'F2') { e.preventDefault(); doReset(); }
  else if (e.key === 'F1') { e.preventDefault(); openOperatorDialog(); }
  else if (e.key === 'Escape') { closeModal(); $$('.menu.open').forEach(m => m.classList.remove('open')); }
});

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
  editorLoad();
  setEditorKind(state.editorKind, false);   // enforce restored editor visibility (may load Monaco)
  initExtSync();
  waitOpenCV().then(ok => { if (ok) log('OpenCV WASM runtime ready.', 'msg'); });
  log('OpenCVS demo started.', 'msg');
  log("Program 'program.ovs' loaded (main, detect_features).", 'msg');
  if (restored) log('Layout restored from previous session.', 'msg');
  log('Press F5 to run, F6 to step.', 'msg');
  renderProgram();
  renderOperator();
  renderVariables();
  renderHistory();
  renderTaskbar();
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
  'win-variable': { col: 'col-right',  before: null },
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
