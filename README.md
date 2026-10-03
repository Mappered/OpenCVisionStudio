# OpenCVisionStudio
VibeCoding playground for OpenCV + Aravis + MachineVision IDE

## Running the HTML demo

```sh
py -m http.server 8123 --bind 127.0.0.1     # any static server will do
```

then open `http://127.0.0.1:8123/index.html`. Opening the file directly with
`file://` does not work — `vendor/opencv.js` and the Monaco loader are fetched
as subresources.

For the full IDE experience use the project's own dev server instead — it also
mirrors `program.ovs` to VS Code and adds the folder listing the browser needs
(see “Loading images”):

```sh
node tools/serve.js          # http://localhost:8177/  (PORT=... to change)
```

### From VS Code

Press **F5** — the bundled Node (`tools/node/node.exe`, nothing to install) starts
`tools/serve.js`, and the page opens in the default browser as soon as the server
prints `OpenCVS dev server:  http://localhost:8177/`. **Stop** ends the server with
the session. If a server from an earlier session is still listening on the port,
F5 reuses it (the URL is printed either way, so the page still opens); if some
other program holds the port, the server moves to the next free one and prints
*that* URL instead of failing. The other entries of the Run and Debug dropdown start the same server
via the *serve: OpenCVS dev server* task and attach the debugger to the page
(breakpoints in `js/app.js`), or open `index.html` over `file://` for a look at the
markup only. `Ctrl+Shift+B` runs the serve task on its own, *test: metrology* runs
the DOM-free half of the test suite.

## Stepping through a program

**F6** executes one line and follows a call *into* the procedure; **F8** steps
*over* it — the whole call runs and the counter stops on the next line of the
caller. Both keep the Program Window on the procedure that is actually running:
the procedure dropdown and the status bar name it, and the ▶ arrow is drawn on the
running line of *that* procedure. So stepping into `find_center (…)` from `main:5`
shows `find_center` with the arrow on its first line (`Stopped at find_center, line
1`), and the return brings the window back to `main:6` — never "line 1 of main"
again, which was what an arrow drawn by line number into the caller's text looked
like. When the next line lies outside the visible part of the program, the window
scrolls it into view (in either direction — a `for` loop that runs back to its
header scrolls back up), without pulling the keyboard focus away from whatever
window you are working in.

**Alt+Enter** opens the sub-procedure a program line calls, the way HDevelop does
(either Alt key works — the right one is AltGr, which Windows reports as Ctrl+Alt):
the Program Window switches to it, the Procedure dropdown above the window follows
and is the way back to the caller. The word under the caret counts, so the caret may
just as well sit inside an argument; an operator (or a line that calls nothing) is
never "opened" — the History says so instead of switching. In the VS Code editor the
same command is also on the context menu and in the command palette (*Open
Sub-Procedure*). Browsing another procedure never disturbs a paused run: the
program counter remembers the procedure it is suspended in, the ▶ arrow is only
drawn while the shown procedure is that one, and the next F5/**F6**/**F8** brings
the window back to the running line and continues there. The Procedure dropdown
switches the window in exactly the same way.
## Execution times

Once a program has run (**F5**) or been stepped through (**F6**/**F8**), the Program
Window shows the time of each executed line next to its line number, the way
HDevelop does. The times are measured around the operator itself — the history
entry and the window refresh that each line causes are *subtracted*, or a 0.1 ms
`count_obj` would report as a 20 ms line — and they are **summed over the run**, so
the body of a loop that runs eight times shows the total of its eight iterations;
that is what makes the column a profile. A procedure call is a single line for the
interpreter, so the call line in the caller carries the sum of the lines the callee
recorded, while the callee's own lines show their own times. The column describes
the *last* execution: F5, F2 or a new program clears it, and a line whose text
changed since it ran loses its time (the statement moved). The browser clock
resolves 0.1 ms, so anything faster reads `<0.1 ms`. **Visualization ▸ Execution
Times** switches the column off and on (the setting is kept in the layout).
## Procedure interfaces

A procedure header carries its interface in HDevelop's own print form, so a
procedure can be called with arguments in the same order HDevelop binds them:

```hdevelop
* procedure: find_center (BaseImage : CenterCross, Cross : : Row, Column)
```

The groups are `iconic in : iconic out : control in : control out`, separated by
colons; a group that is not needed is left empty, and `_` discards a value at the
*call* site (`find_center (Image, _, _, Row, Column)` keeps the first iconic
output and throws the second away). The line is written by the editor and kept
when a program is saved, sent to the dev server (`tools/serve.js`, `/api/program`)
or read back from it, so the interfaces survive a reload. A procedure line
*without* a parenthesised signature still parses — it just declares no interface,
and calling it binds no arguments (the log then says so) — which is how programs
written before this format keep loading. An invalid name in a signature is
reported in the History window instead of being applied.

## Speeding up a loop

Every result that is *displayed* is turned into pixels first: a region or a label
image becomes an RGBA overlay of the whole frame, which on a 5088×3840 photo costs
~130 ms, and `dev_update_on` displays every result of every operator. In a
sub-procedure that runs eight times, that is seconds spent painting results that
nobody looks at. Two rules follow, and both are the ones HDevelop users already
know:

- `dev_update_off ()` while a loop runs (`dev_update_window ('on')` or a
  `dev_display` of the final result afterwards to draw it once). Displaying is
  skipped entirely then, and the overlays are *not* built.
- `select_shape` / `select_shape_std` / `smallest_rectangle2` are the expensive
  operators on large frames — the example's `find_center` costs ~1.9 s per call
  with display updates on and ~1.2 s with them off, of which `read_image`
  (≈0.5 s, the decode of a 5088×3840 PNG) is the floor. Measured over the whole
  example program (eight frames): 15 s as committed, 10 s with `dev_update_off ()`.

The variable window's thumbnails sample the region's own pixels instead of
shrinking its overlay, and the bounding boxes that `connection` already reads from
the component statistics are used by `smallest_rectangle2` / `select_shape_std` to
look at a region's box rather than the whole frame — on the example that turned
`smallest_rectangle2` from 238 ms into 24 ms per call.

## Loading images

A program that does `list_image_files ('./', 'default', [], ImageFiles)` needs the
folder the program lives in. A page cannot enumerate a directory it was not told
about, and it cannot see the path of a file picked in the Open dialog, so the
folder has to be established once in one of these ways:

- **File ▸ Browse Server Folder…** (or "Server…" in the Operator Window) —
  opens a folder browser that walks the server's tree: click a folder to go into
  it, click a program (`*.odev`, `*.hdev`, `*.ovs`) to open it. A fetched program
  has a URL, so its own folder becomes the folder of `list_image_files ('./')`
  automatically, and **Use as image folder** takes the folder you are looking at
  as the one the program reads. Nothing has to be granted.
- **File ▸ Set Working Folder…** (or "Folder…" in the Operator Window) — grants a
  folder through the File System Access API. Images are not decoded here; the
  folder is enumerated and `read_image` decodes only what the program asks for.
- **File ▸ Load Image Folder…** (or "Load folder…") — reads every image of a picked
  folder into memory and makes that folder the one `'./'` means.
- **File ▸ Load Image Files…** (or "Load file…") — takes a hand-picked set; hold
  Ctrl/Shift to pick several at once.

The folder that worked is remembered per program name, so opening the same program
again needs no extra step.

The browser can only see a folder listing the server is willing to give:
`tools/serve.js` answers `/api/list` for every folder (including the page's own,
which is why `'./'` works there with no grant at all), while a plain static server
(`py -m http.server`) answers with an HTML index for the folders that do not hold an
`index.html` — so `example/` can be listed but the folder the app itself lives in
cannot. The Operator Window says which of the two you have, and the browser says so
when a folder cannot be listed. It then also lists the folders that did list before
(plus the program's working folder and the page folder), so a static server is not a
dead end: type a folder (`example`) or a program (`example/MAIN.hdev`) into the
**Path** box, or pick one of the offered folders. Pressing **Open** always answers —
a path that changes nothing says "Already showing …", a wrong path says why it could
not be read, and if the server itself stopped answering the browser says that
instead.

Names are sorted in HALCON's `'default'` order, so `ImageFiles[0]` is the first name
of the folder. The built-in demo image (`printer_chip`) is *not* listed — it is only
the fallback `read_image` uses when a name has not been loaded.

Two things to keep in mind: a listing that comes back empty produces a warning
telling you to grant the folder, and a very large image is never silently resized —
if one ever has to be, `read_image` logs the exact scale factor it applied.

Each image file is read once: the first `read_image` of a file decodes it and keeps
the frame, and every later read of the same file copies it. On a 10 MB, 5088×3840
photo that is the difference between ~0.5 s and ~10 ms per read — the log line of
`read_image` reports which of the two happened and how long it took, which is the
number to watch while a program runs over large photographs.

`open_file` / `fwrite_string` / `close_file` write into memory and offer the
result as a download, because a page cannot write to disk.

