use clap::Subcommand;

/// Escape a Rust string into a valid JavaScript string literal (with quotes).
/// Uses JSON encoding which is a valid subset of JS string encoding.
fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
}

/// JS snippet: check action result from browser.click/type/select/check.
/// Silent on success. On failure, prints error to stderr and exits.
const ACTION_CHECK: &str = r#"function __check(r) {
  if (typeof r === "string") r = JSON.parse(r);
  if (r && r.success === false) {
    const msg = r.error || "Action failed";
    throw { message: msg, name: "ActionError" };
  }
}"#;

/// JS function that injects annotations, takes screenshot, and always cleans up.
/// Returns the screenshot buffer. Expects `els` and `page` in scope.
/// Cleanup is in a finally block so annotations never orphan on the page.
pub const ANNOTATE_SCREENSHOT_JS: &str = r#"await (async () => {
  await page.evaluate((elements) => {
    const existing = document.getElementById("__wi_annotations");
    if (existing) existing.remove();
    const container = document.createElement("div");
    container.id = "__wi_annotations";
    container.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none";
    document.body.appendChild(container);
    elements.forEach((el) => {
      let target;
      if (el.selector.startsWith("xpath=")) {
        const xp = el.selector.slice(6);
        target = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      } else {
        target = document.querySelector(el.selector);
      }
      if (!target) return;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const label = document.createElement("div");
      label.textContent = String(el.index);
      label.style.cssText = "position:fixed;background:#e11;color:#fff;font:bold 11px/14px sans-serif;padding:0 3px;border-radius:3px;z-index:2147483647;pointer-events:none;left:"+(rect.left-1)+"px;top:"+(rect.top-14)+"px;min-width:14px;text-align:center";
      container.appendChild(label);
      const outline = document.createElement("div");
      outline.style.cssText = "position:fixed;border:2px solid #e11;border-radius:2px;z-index:2147483646;pointer-events:none;left:"+rect.left+"px;top:"+rect.top+"px;width:"+rect.width+"px;height:"+rect.height+"px";
      container.appendChild(outline);
    });
  }, els.elements);
  try {
    return await page.screenshot(SCREENSHOT_OPTS);
  } finally {
    await page.evaluate(() => document.getElementById("__wi_annotations")?.remove()).catch(() => {});
  }
})()"#;

/// JS injected into the page to create a visual inspector overlay.
/// User hovers to see component names + source files, clicks to capture.
/// Result stored in window.__clickToFixResult. Extracts React (_debugSource),
/// Vue (__file), Svelte (__svelte_meta), Angular (ng.getComponent) metadata.
/// Credit: Edoardo Re (github.com/edoardorex)
const CLICK_TO_FIX_INJECT_JS: &str = r#"
if(window.__clickToFixActive)return 'already active';
var overlay=document.createElement('div');overlay.id='__ctf-overlay';overlay.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483646;cursor:crosshair;';document.body.appendChild(overlay);
var highlight=document.createElement('div');highlight.id='__ctf-highlight';highlight.style.cssText='position:fixed;border:2px solid #6366f1;background:rgba(99,102,241,0.08);pointer-events:none;z-index:2147483645;display:none;border-radius:3px;transition:all 0.05s ease;';document.body.appendChild(highlight);
var label=document.createElement('div');label.id='__ctf-label';label.style.cssText='position:fixed;background:#6366f1;color:#fff;font:bold 11px/1.4 ui-monospace,monospace;padding:2px 8px;border-radius:4px;z-index:2147483647;pointer-events:none;display:none;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.15);';document.body.appendChild(label);
var banner=document.createElement('div');banner.id='__ctf-banner';banner.style.cssText='position:fixed;top:0;left:0;right:0;background:#6366f1;color:#fff;font:bold 14px/1 system-ui,sans-serif;padding:10px 16px;z-index:2147483647;text-align:center;pointer-events:none;';banner.textContent='INSPECT MODE \u2014 Click any element to trace its source code';document.body.appendChild(banner);
function getSourceInfo(el){var result={tag:el.tagName.toLowerCase(),id:el.id||null,classes:Array.from(el.classList),text:(el.textContent||'').trim().substring(0,120),attributes:{},source:null,component:null,outerSnippet:el.outerHTML.substring(0,300)};for(var i=0;i<el.attributes.length;i++){var a=el.attributes[i];if(a.name.startsWith('data-')||a.name==='aria-label'||a.name==='role'||a.name==='name'||a.name==='placeholder'||a.name==='type'||a.name==='href')result.attributes[a.name]=a.value}var fiber=null;var keys=Object.getOwnPropertyNames(el);for(var j=0;j<keys.length;j++){if(keys[j].startsWith('__reactFiber$')||keys[j].startsWith('__reactInternalInstance$')){fiber=el[keys[j]];break}}if(fiber){var current=fiber;while(current){if(current._debugSource){result.source={file:current._debugSource.fileName,line:current._debugSource.lineNumber,column:current._debugSource.columnNumber};if(current.type){result.component=typeof current.type==='string'?current.type:(current.type.displayName||current.type.name||null)}break}current=current.return||null}if(!result.component){var c=fiber;while(c){if(c.type&&typeof c.type==='function'){result.component=c.type.displayName||c.type.name||null;if(result.component)break}c=c.return||null}}}if(!result.source){var ve=el;while(ve){if(ve.__vueParentComponent){var comp=ve.__vueParentComponent;result.component=(comp.type&&(comp.type.name||comp.type.__name))||null;if(comp.type&&comp.type.__file)result.source={file:comp.type.__file,line:null,column:null};break}ve=ve.parentElement}}if(!result.source){var se=el;while(se){if(se.__svelte_meta){var meta=se.__svelte_meta;result.source={file:(meta.loc&&meta.loc.file)||null,line:(meta.loc&&meta.loc.line)||null,column:(meta.loc&&meta.loc.column)||null};var fn=meta.loc&&meta.loc.file;result.component=fn?fn.split('/').pop().replace('.svelte',''):null;break}se=se.parentElement}}if(!result.source){try{if(typeof ng!=='undefined'&&ng.getComponent){var ac=ng.getComponent(el);if(ac)result.component=(ac.constructor&&ac.constructor.name)||null}}catch(e){}}return result}
overlay.addEventListener('mousemove',function(e){overlay.style.pointerEvents='none';var target=document.elementFromPoint(e.clientX,e.clientY);overlay.style.pointerEvents='';if(!target||target.id==='__ctf-overlay'||target.id==='__ctf-highlight'||target.id==='__ctf-label'||target.id==='__ctf-banner')return;var rect=target.getBoundingClientRect();highlight.style.display='block';highlight.style.top=rect.top+'px';highlight.style.left=rect.left+'px';highlight.style.width=rect.width+'px';highlight.style.height=rect.height+'px';var info=getSourceInfo(target);var txt=info.component||info.tag;if(info.source&&info.source.file){var short=info.source.file.split('/').slice(-2).join('/');txt+=' \u2190 '+short;if(info.source.line)txt+=':'+info.source.line}label.style.display='block';label.style.top=Math.max(0,rect.top-24)+'px';label.style.left=rect.left+'px';label.textContent=txt});
overlay.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();overlay.style.pointerEvents='none';var target=document.elementFromPoint(e.clientX,e.clientY);overlay.style.pointerEvents='';var info=getSourceInfo(target||document.body);window.__clickToFixResult=info;overlay.remove();highlight.remove();label.remove();document.getElementById('__ctf-banner')?.remove();window.__clickToFixActive=false});
window.__clickToFixActive=true;
"#;

#[derive(Subcommand)]
pub enum ActionCommand {
    #[command(about = "Run a script file against the browser")]
    Run {
        #[arg(value_name = "FILE", help = "Path to a JavaScript file to execute")]
        file: String,
    },

    #[command(about = "Navigate to a URL")]
    Open {
        #[arg(help = "URL to navigate to")]
        url: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Discover interactive elements on the page")]
    Discover {
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
        #[arg(long, help = "Only return elements within the viewport")]
        viewport_only: bool,
    },

    #[command(about = "Click an element by discover index or CSS selector")]
    Click {
        #[arg(help = "Element index from discover, or CSS selector")]
        target: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Double-click an element by discover index or CSS selector")]
    Dblclick {
        #[arg(help = "Element index from discover, or CSS selector")]
        target: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Type text into an element (appends to existing value)")]
    Type {
        #[arg(help = "Element index from discover, or CSS selector")]
        target: String,
        #[arg(help = "Text to type")]
        text: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
        #[arg(long, help = "Clear existing value before typing")]
        clear: bool,
    },

    #[command(about = "Fill an element (clears existing value first)")]
    Fill {
        #[arg(help = "Element index from discover, or CSS selector")]
        target: String,
        #[arg(help = "Text to fill")]
        text: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Select a dropdown option")]
    Select {
        #[arg(help = "Element index from discover, or CSS selector")]
        target: String,
        #[arg(help = "Option value or text to select")]
        value: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Check a checkbox or radio button")]
    Check {
        #[arg(help = "Element index from discover, or CSS selector")]
        target: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Uncheck a checkbox")]
    Uncheck {
        #[arg(help = "Element index from discover, or CSS selector")]
        target: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Hover over an element")]
    Hover {
        #[arg(help = "Element index from discover, or CSS selector")]
        target: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Focus an element")]
    Focus {
        #[arg(help = "CSS selector of element to focus")]
        selector: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Take a screenshot")]
    Screenshot {
        #[arg(help = "Output file path (default: screenshot to temp dir)")]
        path: Option<String>,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
        #[arg(long, help = "Capture full scrollable page")]
        full: bool,
        #[arg(long, help = "Overlay numbered element labels from discover")]
        annotate: bool,
    },

    #[command(about = "Get accessibility snapshot of the page")]
    Snapshot {
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Scroll the page or an element")]
    Scroll {
        #[arg(help = "Direction: up, down, left, right")]
        direction: String,
        #[arg(help = "Pixels to scroll (default: 500)", default_value = "500")]
        pixels: i32,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
        #[arg(long, help = "CSS selector to scroll within")]
        selector: Option<String>,
    },

    #[command(about = "Press a keyboard key")]
    Press {
        #[arg(help = "Key to press (e.g., Enter, Tab, Control+a, ArrowDown)")]
        key: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Execute JavaScript in the page context")]
    Eval {
        #[arg(help = "JavaScript code to evaluate")]
        js: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Wait for a condition")]
    Wait {
        #[arg(help = "CSS selector to wait for, or milliseconds (number)")]
        target: Option<String>,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
        #[arg(long, help = "Wait for text to appear on page")]
        text: Option<String>,
        #[arg(long, help = "Wait for URL to match pattern")]
        url: Option<String>,
        #[arg(long, help = "Wait for load state: load, domcontentloaded, networkidle")]
        load: Option<String>,
        #[arg(long, help = "Wait for element to become hidden")]
        hidden: bool,
    },

    #[command(about = "Upload a file to a file input")]
    Upload {
        #[arg(help = "Element index from discover, or CSS selector")]
        target: String,
        #[arg(help = "File path(s) to upload")]
        files: Vec<String>,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Save page as PDF")]
    Pdf {
        #[arg(help = "Output file path")]
        path: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Drag from one position to another")]
    Drag {
        #[arg(help = "Source X coordinate")]
        from_x: f64,
        #[arg(help = "Source Y coordinate")]
        from_y: f64,
        #[arg(help = "Target X coordinate")]
        to_x: f64,
        #[arg(help = "Target Y coordinate")]
        to_y: f64,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Scroll an element into the viewport")]
    Scrollintoview {
        #[arg(help = "Element discover index or CSS selector")]
        target: String,
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Find elements by semantic locator")]
    Find {
        #[command(subcommand)]
        what: FindCommand,
    },

    #[command(about = "Read/write localStorage or sessionStorage")]
    Storage {
        #[command(subcommand)]
        action: StorageCommand,
    },

    #[command(about = "Read/write clipboard")]
    Clipboard {
        #[command(subcommand)]
        action: ClipboardCommand,
    },

    // --- Get subcommands ---
    #[command(about = "Get page information")]
    Get {
        #[command(subcommand)]
        what: GetCommand,
    },

    // --- Tab subcommands ---
    #[command(about = "Manage browser tabs")]
    Tab {
        #[command(subcommand)]
        action: TabCommand,
    },

    // --- Cookie subcommands ---
    #[command(about = "Manage cookies")]
    Cookies {
        #[command(subcommand)]
        action: CookieCommand,
    },

    // --- Mouse subcommands ---
    #[command(about = "Low-level mouse control")]
    Mouse {
        #[command(subcommand)]
        action: MouseCommand,
    },

    // --- Keyboard subcommands ---
    #[command(about = "Low-level keyboard control")]
    Keyboard {
        #[command(subcommand)]
        action: KeyboardCommand,
    },

    // --- Set subcommands ---
    #[command(about = "Configure browser settings")]
    Set {
        #[command(subcommand)]
        what: SetCommand,
    },

    #[command(about = "Read browser console messages (JS errors, warnings, logs)")]
    Console {
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
        #[arg(long, help = "Filter: error, warn, log, info")]
        level: Option<String>,
        #[arg(long, help = "Filter by text substring")]
        filter: Option<String>,
    },

    // --- Network subcommands ---
    #[command(about = "Network interception and monitoring")]
    Network {
        #[command(subcommand)]
        action: NetworkCommand,
    },

    // --- Existing commands ---
    #[command(about = "Show or change the browser engine mode (default or assistant)")]
    Mode {
        #[arg(help = "Mode: 'default' (Playwright) or 'assistant' (Patchright)")]
        target: Option<String>,
    },

    #[command(name = "browser-mode", about = "Show or change how the browser is launched (auto, real, or sandbox)")]
    BrowserMode {
        #[arg(help = "Mode: 'auto', 'real' (your running browser), or 'sandbox' (managed)")]
        target: Option<String>,
    },

    #[command(name = "click-to-fix", about = "Click any browser element to trace it to its source code")]
    ClickToFix {
        #[arg(long, default_value = "default", help = "Named page to use")]
        page: String,
    },

    #[command(about = "Install the browser runtime and headless Chromium")]
    Install,

    #[command(about = "Install the web-interact skill into agent skill directories")]
    InstallSkill,

    #[command(about = "List all managed browser instances")]
    Browsers,

    #[command(about = "Show daemon status")]
    Status,

    #[command(about = "Stop the daemon and all browsers")]
    Stop,

    #[command(about = "Close a browser or page")]
    Close {
        #[arg(long, help = "Close the entire browser, not just the page")]
        all: bool,
        #[arg(long, default_value = "default", help = "Named page to close")]
        page: String,
    },
}

#[derive(Subcommand)]
pub enum GetCommand {
    #[command(about = "Get current page URL")]
    Url {
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Get current page title")]
    Title {
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Get text content of an element")]
    Text {
        #[arg(help = "CSS selector")]
        selector: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Get innerHTML of an element")]
    Html {
        #[arg(help = "CSS selector")]
        selector: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Get value of an input element")]
    Value {
        #[arg(help = "CSS selector")]
        selector: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Get an attribute of an element")]
    Attr {
        #[arg(help = "CSS selector")]
        selector: String,
        #[arg(help = "Attribute name")]
        attribute: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Get bounding box of an element")]
    Box {
        #[arg(help = "CSS selector")]
        selector: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Check if an element is visible")]
    Visible {
        #[arg(help = "CSS selector")]
        selector: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Check if an element is enabled")]
    Enabled {
        #[arg(help = "CSS selector")]
        selector: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Check if a checkbox/radio is checked")]
    Checked {
        #[arg(help = "CSS selector")]
        selector: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Count elements matching a selector")]
    Count {
        #[arg(help = "CSS selector")]
        selector: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Get computed CSS styles of an element")]
    Styles {
        #[arg(help = "CSS selector")]
        selector: String,
        #[arg(help = "Specific CSS property (optional, returns all if omitted)")]
        property: Option<String>,
        #[arg(long, default_value = "default")]
        page: String,
    },
}

#[derive(Subcommand)]
pub enum FindCommand {
    #[command(about = "Find elements by ARIA role")]
    Role {
        #[arg(help = "ARIA role (button, link, textbox, etc.)")]
        role: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Find elements by text content")]
    Text {
        #[arg(help = "Text to search for")]
        text: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Find elements by label")]
    Label {
        #[arg(help = "Label text")]
        label: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Find elements by placeholder")]
    Placeholder {
        #[arg(help = "Placeholder text")]
        placeholder: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
}

#[derive(Subcommand)]
pub enum StorageCommand {
    #[command(about = "Get localStorage value")]
    Local {
        #[arg(help = "Key to get (omit for all)")]
        key: Option<String>,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(name = "local-set", about = "Set localStorage value")]
    LocalSet {
        #[arg(help = "Key")]
        key: String,
        #[arg(help = "Value")]
        value: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Get sessionStorage value")]
    Session {
        #[arg(help = "Key to get (omit for all)")]
        key: Option<String>,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(name = "session-set", about = "Set sessionStorage value")]
    SessionSet {
        #[arg(help = "Key")]
        key: String,
        #[arg(help = "Value")]
        value: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
}

#[derive(Subcommand)]
pub enum ClipboardCommand {
    #[command(about = "Read clipboard contents")]
    Read {
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Write text to clipboard")]
    Write {
        #[arg(help = "Text to write")]
        text: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
}

#[derive(Subcommand)]
pub enum TabCommand {
    #[command(about = "List all open tabs")]
    List,
    #[command(about = "Open a new tab")]
    New {
        #[arg(help = "URL to open (optional)")]
        url: Option<String>,
    },
    #[command(about = "Switch to a tab by name")]
    Switch {
        #[arg(help = "Tab name or target ID")]
        name: String,
    },
    #[command(about = "Close a tab")]
    Close {
        #[arg(help = "Tab name to close (default: current)", default_value = "default")]
        name: String,
    },
}

#[derive(Subcommand)]
pub enum CookieCommand {
    #[command(about = "Get all cookies")]
    Get {
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Set a cookie")]
    Set {
        #[arg(help = "Cookie name")]
        name: String,
        #[arg(help = "Cookie value")]
        value: String,
        #[arg(long, help = "Cookie domain")]
        domain: Option<String>,
        #[arg(long, help = "Cookie path")]
        path: Option<String>,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Clear all cookies")]
    Clear {
        #[arg(long, default_value = "default")]
        page: String,
    },
}

#[derive(Subcommand)]
pub enum MouseCommand {
    #[command(about = "Move mouse to coordinates")]
    Move {
        #[arg(help = "X coordinate")]
        x: f64,
        #[arg(help = "Y coordinate")]
        y: f64,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Click at coordinates")]
    Click {
        #[arg(help = "X coordinate")]
        x: f64,
        #[arg(help = "Y coordinate")]
        y: f64,
        #[arg(long, default_value = "left", help = "Mouse button: left, right, middle")]
        button: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Mouse button down")]
    Down {
        #[arg(long, default_value = "left")]
        button: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Mouse button up")]
    Up {
        #[arg(long, default_value = "left")]
        button: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Scroll wheel")]
    Wheel {
        #[arg(help = "Vertical scroll delta")]
        dy: f64,
        #[arg(help = "Horizontal scroll delta", default_value = "0")]
        dx: f64,
        #[arg(long, default_value = "default")]
        page: String,
    },
}

#[derive(Subcommand)]
pub enum KeyboardCommand {
    #[command(about = "Type text via keyboard (no selector needed)")]
    Type {
        #[arg(help = "Text to type")]
        text: String,
        #[arg(long, default_value = "default")]
        page: String,
        #[arg(long, help = "Delay between keystrokes in ms")]
        delay: Option<u32>,
    },
    #[command(about = "Insert text without key events")]
    Insert {
        #[arg(help = "Text to insert")]
        text: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Press and release a key")]
    Press {
        #[arg(help = "Key to press")]
        key: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Hold a key down")]
    Down {
        #[arg(help = "Key to press down")]
        key: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Release a key")]
    Up {
        #[arg(help = "Key to release")]
        key: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
}

#[derive(Subcommand)]
pub enum SetCommand {
    #[command(about = "Set viewport size")]
    Viewport {
        #[arg(help = "Width in pixels")]
        width: u32,
        #[arg(help = "Height in pixels")]
        height: u32,
        #[arg(long, help = "Device scale factor", default_value = "1")]
        scale: f64,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Set geolocation")]
    Geo {
        #[arg(help = "Latitude")]
        latitude: f64,
        #[arg(help = "Longitude")]
        longitude: f64,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Set offline mode")]
    Offline {
        #[arg(help = "on or off", default_value = "on")]
        state: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Set color scheme preference")]
    Media {
        #[arg(help = "Color scheme: dark, light, no-preference")]
        scheme: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Set extra HTTP headers")]
    Headers {
        #[arg(help = "JSON object of headers")]
        json: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
}

#[derive(Subcommand)]
pub enum NetworkCommand {
    #[command(about = "List captured network requests")]
    Requests {
        #[arg(long, default_value = "default")]
        page: String,
        #[arg(long, help = "Filter by URL pattern")]
        filter: Option<String>,
        #[arg(long, help = "Filter by resource type")]
        r#type: Option<String>,
        #[arg(long, help = "Filter by HTTP method")]
        method: Option<String>,
    },
    #[command(about = "Block requests matching a URL pattern")]
    Block {
        #[arg(help = "URL pattern to block")]
        pattern: String,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Intercept requests matching a pattern")]
    Route {
        #[arg(help = "URL pattern to intercept")]
        pattern: String,
        #[arg(long, help = "Abort matched requests")]
        abort: bool,
        #[arg(long, help = "Respond with this JSON body")]
        body: Option<String>,
        #[arg(long, default_value = "200", help = "HTTP status code for response")]
        status: u16,
        #[arg(long, default_value = "default")]
        page: String,
    },
    #[command(about = "Remove a route")]
    Unroute {
        #[arg(help = "URL pattern to remove (omit for all)")]
        pattern: Option<String>,
        #[arg(long, default_value = "default")]
        page: String,
    },
}

/// Generate a JavaScript script for the given command.
/// Returns None for commands that don't generate scripts (Install, Status, etc.).
pub fn generate_script(command: &ActionCommand) -> Option<String> {
    match command {
        ActionCommand::Run { .. }
        | ActionCommand::Mode { .. }
        | ActionCommand::BrowserMode { .. }
        | ActionCommand::Install
        | ActionCommand::InstallSkill
        | ActionCommand::Browsers
        | ActionCommand::Status
        | ActionCommand::Stop => None,

        ActionCommand::Open { url, page } => Some(format!(
            r#"const page = await browser.getPage({page});
await page.goto({url});"#,
            page = js_str(page),
            url = js_str(url)
        )),

        ActionCommand::Discover { page, viewport_only } => Some(format!(
            r#"const result = await browser.discover({page}{opts});
console.log(result.serialized);"#,
            page = js_str(page),
            opts = if *viewport_only {
                ", { viewportOnly: true }".to_string()
            } else {
                String::new()
            }
        )),

        ActionCommand::ClickToFix { page } => Some(format!(
            r#"const page = await browser.getPage({page});
await page.evaluate(() => {{ window.__clickToFixResult = undefined; }});
await page.evaluate(() => {{ {CLICK_TO_FIX_INJECT_JS} }});
await page.waitForFunction(() => window.__clickToFixResult !== undefined, {{ timeout: 120000 }});
const result = await page.evaluate(() => JSON.stringify(window.__clickToFixResult));
console.log(result);"#,
            page = js_str(page),
        )),

        ActionCommand::Click { target, page } => Some(format!("{ACTION_CHECK}\n{}", gen_action_by_target(
            page, target, "click",
            |page_js, idx| format!(
                "__check(await browser.click({page_js}, {idx}));"
            ),
            |page_js, sel| format!(
                "__check(await browser.click({page_js}, {sel}));"
            ),
        ))),

        ActionCommand::Dblclick { target, page } => Some(gen_action_by_target(
            page, target, "dblclick",
            |page_js, idx| format!(
                r#"const page = await browser.getPage({page_js});
const session = await page.context().newCDPSession(page);
try {{
  await session.send("DOM.enable");
  const els = await browser.discover({page_js});
  const el = els.elements[{idx} - 1];
  if (!el) throw new Error("Element [" + {idx} + "] not found");
  const {{ model }} = await session.send("DOM.getBoxModel", {{ backendNodeId: el.backendNodeId }});
  const x = (model.content[0] + model.content[2]) / 2;
  const y = (model.content[1] + model.content[5]) / 2;
  await page.mouse.dblclick(x, y);
}} finally {{ await session.detach().catch(() => {{}}); }}"#,
            ),
            |page_js, sel| format!(
                "const page = await browser.getPage({page_js});\nawait page.dblclick({sel});"
            ),
        )),

        ActionCommand::Type { target, text, page, clear } => {
            let clear_opt = if *clear { ", { clearFirst: true }" } else { "" };
            Some(format!("{ACTION_CHECK}\n{}", gen_action_by_target(
                page, target, "type",
                |page_js, idx| format!(
                    "__check(await browser.type({page_js}, {idx}, {text}{clear_opt}));",
                    text = js_str(text),
                ),
                |page_js, sel| format!(
                    "const page = await browser.getPage({page_js});\nawait page.type({sel}, {text});",
                    text = js_str(text),
                ),
            )))
        }

        ActionCommand::Fill { target, text, page } => Some(format!("{ACTION_CHECK}\n{}", gen_action_by_target(
            page, target, "fill",
            |page_js, idx| format!(
                "__check(await browser.type({page_js}, {idx}, {text}, {{ clearFirst: true }}));",
                text = js_str(text),
            ),
            |page_js, sel| format!(
                "const page = await browser.getPage({page_js});\nawait page.fill({sel}, {text});",
                text = js_str(text),
            ),
        ))),

        ActionCommand::Select { target, value, page } => Some(format!("{ACTION_CHECK}\n{}", gen_action_by_target(
            page, target, "select",
            |page_js, idx| format!(
                "__check(await browser.select({page_js}, {idx}, {val}));",
                val = js_str(value),
            ),
            |page_js, sel| format!(
                "const page = await browser.getPage({page_js});\nawait page.selectOption({sel}, {val});",
                val = js_str(value),
            ),
        ))),

        ActionCommand::Check { target, page } => Some(format!("{ACTION_CHECK}\n{}", gen_action_by_target(
            page, target, "check",
            |page_js, idx| format!(
                "__check(await browser.check({page_js}, {idx}, true));"
            ),
            |page_js, sel| format!(
                "const page = await browser.getPage({page_js});\nawait page.check({sel});"
            ),
        ))),

        ActionCommand::Uncheck { target, page } => Some(format!("{ACTION_CHECK}\n{}", gen_action_by_target(
            page, target, "uncheck",
            |page_js, idx| format!(
                "__check(await browser.check({page_js}, {idx}, false));"
            ),
            |page_js, sel| format!(
                "const page = await browser.getPage({page_js});\nawait page.uncheck({sel});"
            ),
        ))),

        ActionCommand::Hover { target, page } => Some(gen_action_by_target(
            page, target, "hover",
            |page_js, idx| format!(
                r#"const page = await browser.getPage({page_js});
const els = await browser.discover({page_js});
const el = els.elements[{idx} - 1];
if (!el) throw new Error("Element [" + {idx} + "] not found");
await page.hover(el.selector);"#,
            ),
            |page_js, sel| format!(
                "const page = await browser.getPage({page_js});\nawait page.hover({sel});"
            ),
        )),

        ActionCommand::Focus { selector, page } => Some(format!(
            "const page = await browser.getPage({page});\nawait page.focus({sel});",
            page = js_str(page),
            sel = js_str(selector),
        )),

        ActionCommand::Screenshot { path, page, full, annotate } => {
            let filename = path.as_deref().unwrap_or("screenshot.png");
            let full_opt = if *full { "fullPage: true" } else { "" };
            if *annotate {
                Some(format!(
                    "const page = await browser.getPage({page});\nconst els = await browser.discover({page});\nconst SCREENSHOT_OPTS = {{ {full_opt} }};\nconst buf = {annotate_fn};\nconst p = await saveScreenshot(buf, {filename});\nconsole.log(p);",
                    page = js_str(page),
                    filename = js_str(filename),
                    annotate_fn = ANNOTATE_SCREENSHOT_JS,
                ))
            } else {
                Some(format!(
                    r#"const page = await browser.getPage({page});
const buf = await page.screenshot({{ {full_opt} }});
const p = await saveScreenshot(buf, {filename});
console.log(p);"#,
                    page = js_str(page),
                    filename = js_str(filename),
                ))
            }
        }

        ActionCommand::Snapshot { page } => Some(format!(
            r#"const page = await browser.getPage({page});
const snapshot = await page.locator("body").ariaSnapshot();
console.log(snapshot);"#,
            page = js_str(page),
        )),

        ActionCommand::Scroll { direction, pixels, page, selector } => {
            let (dx, dy) = match direction.as_str() {
                "up" => (0, -(*pixels)),
                "down" => (0, *pixels),
                "left" => (-(*pixels), 0),
                "right" => (*pixels, 0),
                _ => (0, *pixels),
            };
            if let Some(sel) = selector {
                Some(format!(
                    r#"const page = await browser.getPage({page});
await page.evaluate((arg) => {{
  const el = document.querySelector(arg.s);
  if (el) el.scrollBy(arg.dx, arg.dy);
}}, {{ s: {sel}, dx: {dx}, dy: {dy} }});"#,
                    page = js_str(page),
                    sel = js_str(sel),
                ))
            } else {
                Some(format!(
                    r#"const page = await browser.getPage({page});
await page.evaluate((arg) => window.scrollBy(arg.dx, arg.dy), {{ dx: {dx}, dy: {dy} }});"#,
                    page = js_str(page),
                ))
            }
        }

        ActionCommand::Press { key, page } => Some(format!(
            "const page = await browser.getPage({page});\nawait page.keyboard.press({key});",
            page = js_str(page),
            key = js_str(key),
        )),

        ActionCommand::Eval { js, page } => Some(format!(
            r#"const page = await browser.getPage({page});
const result = await page.evaluate(() => {{ return {js}; }});
if (result !== undefined) console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));"#,
            page = js_str(page),
            js = js,
        )),

        ActionCommand::Wait { target, page, text, url, load, hidden } => {
            if let Some(txt) = text {
                Some(format!(
                    "const page = await browser.getPage({page});\nawait page.waitForFunction((t) => document.body?.innerText?.includes(t), {txt});",
                    page = js_str(page),
                    txt = js_str(txt),
                ))
            } else if let Some(u) = url {
                Some(format!(
                    "const page = await browser.getPage({page});\nawait page.waitForURL({url});",
                    page = js_str(page),
                    url = js_str(u),
                ))
            } else if let Some(state) = load {
                Some(format!(
                    "const page = await browser.getPage({page});\nawait page.waitForLoadState({state});",
                    page = js_str(page),
                    state = js_str(state),
                ))
            } else if let Some(t) = target {
                if t.parse::<u64>().is_ok() {
                    Some(format!(
                        "const page = await browser.getPage({page});\nawait page.waitForTimeout({ms});",
                        page = js_str(page),
                        ms = t,
                    ))
                } else {
                    let state_opt = if *hidden { ", { state: \"hidden\" }" } else { "" };
                    Some(format!(
                        "const page = await browser.getPage({page});\nawait page.waitForSelector({sel}{state_opt});",
                        page = js_str(page),
                        sel = js_str(t),
                    ))
                }
            } else {
                Some(format!(
                    "const page = await browser.getPage({page});\nawait page.waitForLoadState(\"networkidle\");",
                    page = js_str(page),
                ))
            }
        }

        ActionCommand::Upload { target, files, page } => {
            let files_json: Vec<String> = files.iter().map(|f| js_str(f)).collect();
            let files_arr = format!("[{}]", files_json.join(", "));
            Some(gen_action_by_target(
                page, target, "upload",
                |page_js, idx| format!(
                    r#"const page = await browser.getPage({page_js});
const els = await browser.discover({page_js});
const el = els.elements[{idx} - 1];
if (!el) throw new Error("Element [" + {idx} + "] not found");
await page.setInputFiles(el.selector, {files_arr});"#,
                ),
                |page_js, sel| format!(
                    "const page = await browser.getPage({page_js});\nawait page.setInputFiles({sel}, {files_arr});"
                ),
            ))
        }

        ActionCommand::Pdf { path, page } => Some(format!(
            r#"const page = await browser.getPage({page});
const buf = await page.pdf();
const p = await writeFile({path}, buf);
console.log(p);"#,
            page = js_str(page),
            path = js_str(path),
        )),

        ActionCommand::Drag { from_x, from_y, to_x, to_y, page } => Some(format!(
            "await browser.drag({page}, {from_x}, {from_y}, {to_x}, {to_y});",
            page = js_str(page),
        )),

        ActionCommand::Close { all, page } => {
            if *all {
                Some("// browser-stop handled at protocol level".to_string())
            } else {
                Some(format!(
                    "await browser.closePage({page});",
                    page = js_str(page),
                ))
            }
        }

        // --- Scrollintoview ---
        ActionCommand::Scrollintoview { target, page } => {
            if let Ok(_idx) = target.parse::<u64>() {
                Some(format!(
                    r#"const els = await browser.discover({page});
const el = els.elements[{idx} - 1];
if (!el) throw new Error("Element [" + {idx} + "] not found");
const p = await browser.getPage({page});
await p.evaluate((sel) => {{
  let e;
  if (sel.startsWith("xpath=")) {{
    e = document.evaluate(sel.slice(6), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  }} else {{
    e = document.querySelector(sel);
  }}
  if (e) e.scrollIntoView({{ block: "center", behavior: "instant" }});
}}, el.selector);"#,
                    page = js_str(page),
                    idx = target,
                ))
            } else {
                Some(format!(
                    r#"const page = await browser.getPage({page});
await page.evaluate((s) => {{ const e = document.querySelector(s); if (e) e.scrollIntoView({{ block: "center", behavior: "instant" }}); }}, {sel});"#,
                    page = js_str(page),
                    sel = js_str(target),
                ))
            }
        }

        // --- Find ---
        ActionCommand::Find { what } => Some(match what {
            FindCommand::Role { role, page } => format!(
                r#"const page = await browser.getPage({p});
const els = await page.getByRole({role}).all();
for (const el of els) {{
  const text = await el.textContent().catch(() => "");
  const tag = await el.evaluate(e => e.tagName.toLowerCase());
  const visible = await el.isVisible();
  if (visible) console.log(tag + " " + {role} + ": " + (text || "").trim().substring(0, 80));
}}"#,
                p = js_str(page),
                role = js_str(role),
            ),
            FindCommand::Text { text, page } => format!(
                r#"const page = await browser.getPage({p});
const els = await page.getByText({text}).all();
for (const el of els) {{
  const tag = await el.evaluate(e => e.tagName.toLowerCase());
  const visible = await el.isVisible();
  if (visible) console.log(tag + ": " + await el.textContent());
}}"#,
                p = js_str(page),
                text = js_str(text),
            ),
            FindCommand::Label { label, page } => format!(
                r#"const page = await browser.getPage({p});
const els = await page.getByLabel({label}).all();
for (const el of els) {{
  const tag = await el.evaluate(e => e.tagName.toLowerCase() + (e.type ? "[" + e.type + "]" : ""));
  const val = await el.inputValue().catch(() => "");
  console.log(tag + " label=" + {label} + (val ? " value=" + JSON.stringify(val) : ""));
}}"#,
                p = js_str(page),
                label = js_str(label),
            ),
            FindCommand::Placeholder { placeholder, page } => format!(
                r#"const page = await browser.getPage({p});
const els = await page.getByPlaceholder({ph}).all();
for (const el of els) {{
  const tag = await el.evaluate(e => e.tagName.toLowerCase() + (e.type ? "[" + e.type + "]" : ""));
  console.log(tag + " placeholder=" + {ph});
}}"#,
                p = js_str(page),
                ph = js_str(placeholder),
            ),
        }),

        // --- Storage ---
        ActionCommand::Storage { action } => Some(match action {
            StorageCommand::Local { key: Some(k), page } => format!(
                "const page = await browser.getPage({p});\nconst v = await page.evaluate((k) => localStorage.getItem(k), {k});\nconsole.log(v ?? \"\");",
                p = js_str(page), k = js_str(k),
            ),
            StorageCommand::Local { key: None, page } => format!(
                r#"const page = await browser.getPage({p});
const data = await page.evaluate(() => {{ const o = {{}}; for (let i = 0; i < localStorage.length; i++) {{ const k = localStorage.key(i); o[k] = localStorage.getItem(k); }} return o; }});
console.log(JSON.stringify(data, null, 2));"#,
                p = js_str(page),
            ),
            StorageCommand::LocalSet { key, value, page } => format!(
                "const page = await browser.getPage({p});\nawait page.evaluate((arg) => localStorage.setItem(arg.k, arg.v), {{ k: {k}, v: {v} }});",
                p = js_str(page), k = js_str(key), v = js_str(value),
            ),
            StorageCommand::Session { key: Some(k), page } => format!(
                "const page = await browser.getPage({p});\nconst v = await page.evaluate((k) => sessionStorage.getItem(k), {k});\nconsole.log(v ?? \"\");",
                p = js_str(page), k = js_str(k),
            ),
            StorageCommand::Session { key: None, page } => format!(
                r#"const page = await browser.getPage({p});
const data = await page.evaluate(() => {{ const o = {{}}; for (let i = 0; i < sessionStorage.length; i++) {{ const k = sessionStorage.key(i); o[k] = sessionStorage.getItem(k); }} return o; }});
console.log(JSON.stringify(data, null, 2));"#,
                p = js_str(page),
            ),
            StorageCommand::SessionSet { key, value, page } => format!(
                "const page = await browser.getPage({p});\nawait page.evaluate((arg) => sessionStorage.setItem(arg.k, arg.v), {{ k: {k}, v: {v} }});",
                p = js_str(page), k = js_str(key), v = js_str(value),
            ),
        }),

        // --- Clipboard ---
        ActionCommand::Clipboard { action } => Some(match action {
            ClipboardCommand::Read { page } => format!(
                "const page = await browser.getPage({p});\nconst text = await page.evaluate(() => navigator.clipboard.readText());\nconsole.log(text);",
                p = js_str(page),
            ),
            ClipboardCommand::Write { text, page } => format!(
                "const page = await browser.getPage({p});\nawait page.evaluate((t) => navigator.clipboard.writeText(t), {t});",
                p = js_str(page), t = js_str(text),
            ),
        }),

        // --- Get subcommands ---
        ActionCommand::Get { what } => Some(match what {
            GetCommand::Url { page } => format!(
                "const page = await browser.getPage({p});\nconsole.log(page.url());",
                p = js_str(page),
            ),
            GetCommand::Title { page } => format!(
                "const page = await browser.getPage({p});\nconsole.log(await page.title());",
                p = js_str(page),
            ),
            GetCommand::Text { selector, page } => format!(
                "const page = await browser.getPage({p});\nconst t = await page.textContent({sel});\nconsole.log(t ?? \"\");",
                p = js_str(page),
                sel = js_str(selector),
            ),
            GetCommand::Html { selector, page } => format!(
                "const page = await browser.getPage({p});\nconst h = await page.innerHTML({sel});\nconsole.log(h);",
                p = js_str(page),
                sel = js_str(selector),
            ),
            GetCommand::Value { selector, page } => format!(
                "const page = await browser.getPage({p});\nconst v = await page.inputValue({sel});\nconsole.log(v);",
                p = js_str(page),
                sel = js_str(selector),
            ),
            GetCommand::Attr { selector, attribute, page } => format!(
                "const page = await browser.getPage({p});\nconst v = await page.getAttribute({sel}, {attr});\nconsole.log(v ?? \"\");",
                p = js_str(page),
                sel = js_str(selector),
                attr = js_str(attribute),
            ),
            GetCommand::Box { selector, page } => format!(
                r#"const page = await browser.getPage({p});
const box = await page.locator({sel}).boundingBox();
console.log(JSON.stringify(box));"#,
                p = js_str(page),
                sel = js_str(selector),
            ),
            GetCommand::Visible { selector, page } => format!(
                "const page = await browser.getPage({p});\nconst v = await page.locator({sel}).isVisible();\nconsole.log(v);",
                p = js_str(page),
                sel = js_str(selector),
            ),
            GetCommand::Enabled { selector, page } => format!(
                "const page = await browser.getPage({p});\nconst v = await page.locator({sel}).isEnabled();\nconsole.log(v);",
                p = js_str(page),
                sel = js_str(selector),
            ),
            GetCommand::Checked { selector, page } => format!(
                "const page = await browser.getPage({p});\nconst v = await page.locator({sel}).isChecked();\nconsole.log(v);",
                p = js_str(page),
                sel = js_str(selector),
            ),
            GetCommand::Count { selector, page } => format!(
                "const page = await browser.getPage({p});\nconst c = await page.locator({sel}).count();\nconsole.log(c);",
                p = js_str(page),
                sel = js_str(selector),
            ),
            GetCommand::Styles { selector, property, page } => {
                if let Some(prop) = property {
                    format!(
                        "const page = await browser.getPage({p});\nconst v = await page.locator({sel}).evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), {prop});\nconsole.log(v);",
                        p = js_str(page), sel = js_str(selector), prop = js_str(prop),
                    )
                } else {
                    format!(
                        r#"const page = await browser.getPage({p});
const styles = await page.locator({sel}).evaluate(e => {{
  const cs = getComputedStyle(e);
  const result = {{}};
  for (const prop of ["display","position","width","height","margin","padding","color","background","font-size","font-weight","border","opacity","visibility","z-index","overflow","cursor"]) {{
    result[prop] = cs.getPropertyValue(prop);
  }}
  return result;
}});
console.log(JSON.stringify(styles, null, 2));"#,
                        p = js_str(page), sel = js_str(selector),
                    )
                }
            }
        }),

        // --- Tab subcommands ---
        ActionCommand::Tab { action } => Some(match action {
            TabCommand::List => "const tabs = await browser.listPages();\nconsole.log(JSON.stringify(tabs, null, 2));".to_string(),
            TabCommand::New { url } => match url {
                Some(u) => format!(
                    "const page = await browser.newPage();\nawait page.goto({url});",
                    url = js_str(u),
                ),
                None => "await browser.newPage();".to_string(),
            },
            TabCommand::Switch { name } => format!(
                "const page = await browser.getPage({name});\nawait page.bringToFront();",
                name = js_str(name),
            ),
            TabCommand::Close { name } => format!(
                "await browser.closePage({name});",
                name = js_str(name),
            ),
        }),

        // --- Cookie subcommands ---
        ActionCommand::Cookies { action } => Some(match action {
            CookieCommand::Get { page } => format!(
                r#"const page = await browser.getPage({p});
const cookies = await page.context().cookies();
console.log(JSON.stringify(cookies, null, 2));"#,
                p = js_str(page),
            ),
            CookieCommand::Set { name, value, domain, path, page } => {
                let domain_js = domain.as_deref().map(|d| format!(", domain: {}", js_str(d))).unwrap_or_default();
                let path_js = path.as_deref().map(|p| format!(", path: {}", js_str(p))).unwrap_or_default();
                format!(
                    r#"const p = await browser.getPage({pg});
await p.context().addCookies([{{ name: {n}, value: {v}, url: p.url(){domain_js}{path_js} }}]);"#,
                    pg = js_str(page),
                    n = js_str(name),
                    v = js_str(value),
                )
            }
            CookieCommand::Clear { page } => format!(
                "const page = await browser.getPage({p});\nawait page.context().clearCookies();",
                p = js_str(page),
            ),
        }),

        // --- Mouse subcommands ---
        ActionCommand::Mouse { action } => Some(match action {
            MouseCommand::Move { x, y, page } => format!(
                "const page = await browser.getPage({p});\nawait page.mouse.move({x}, {y});",
                p = js_str(page),
            ),
            MouseCommand::Click { x, y, button, page } => format!(
                "const page = await browser.getPage({p});\nawait page.mouse.click({x}, {y}, {{ button: {btn} }});",
                p = js_str(page),
                btn = js_str(button),
            ),
            MouseCommand::Down { button, page } => format!(
                "const page = await browser.getPage({p});\nawait page.mouse.down({{ button: {btn} }});",
                p = js_str(page),
                btn = js_str(button),
            ),
            MouseCommand::Up { button, page } => format!(
                "const page = await browser.getPage({p});\nawait page.mouse.up({{ button: {btn} }});",
                p = js_str(page),
                btn = js_str(button),
            ),
            MouseCommand::Wheel { dy, dx, page } => format!(
                "const page = await browser.getPage({p});\nawait page.mouse.wheel({dx}, {dy});",
                p = js_str(page),
            ),
        }),

        // --- Keyboard subcommands ---
        ActionCommand::Keyboard { action } => Some(match action {
            KeyboardCommand::Type { text, page, delay } => {
                let delay_opt = delay.map(|d| format!(", {{ delay: {d} }}")).unwrap_or_default();
                format!(
                    "const page = await browser.getPage({p});\nawait page.keyboard.type({text}{delay_opt});",
                    p = js_str(page),
                    text = js_str(text),
                )
            }
            KeyboardCommand::Insert { text, page } => format!(
                "const page = await browser.getPage({p});\nawait page.keyboard.insertText({text});",
                p = js_str(page),
                text = js_str(text),
            ),
            KeyboardCommand::Press { key, page } => format!(
                "const page = await browser.getPage({p});\nawait page.keyboard.press({key});",
                p = js_str(page),
                key = js_str(key),
            ),
            KeyboardCommand::Down { key, page } => format!(
                "const page = await browser.getPage({p});\nawait page.keyboard.down({key});",
                p = js_str(page),
                key = js_str(key),
            ),
            KeyboardCommand::Up { key, page } => format!(
                "const page = await browser.getPage({p});\nawait page.keyboard.up({key});",
                p = js_str(page),
                key = js_str(key),
            ),
        }),

        // --- Set subcommands ---
        ActionCommand::Set { what } => Some(match what {
            SetCommand::Viewport { width, height, scale: _, page } => format!(
                "const page = await browser.getPage({p});\nawait page.setViewportSize({{ width: {width}, height: {height} }});",
                p = js_str(page),
            ),
            SetCommand::Geo { latitude, longitude, page } => format!(
                r#"const page = await browser.getPage({p});
await page.context().setGeolocation({{ latitude: {latitude}, longitude: {longitude} }});
await page.context().grantPermissions(["geolocation"]);"#,
                p = js_str(page),
            ),
            SetCommand::Offline { state, page } => format!(
                "const page = await browser.getPage({p});\nawait page.context().setOffline({offline});",
                p = js_str(page),
                offline = if state == "on" { "true" } else { "false" },
            ),
            SetCommand::Media { scheme, page } => format!(
                "const page = await browser.getPage({p});\nawait page.emulateMedia({{ colorScheme: {scheme} }});",
                p = js_str(page),
                scheme = js_str(scheme),
            ),
            SetCommand::Headers { json, page } => format!(
                "const page = await browser.getPage({p});\nawait page.setExtraHTTPHeaders({json});",
                p = js_str(page),
                json = json,
            ),
        }),

        // --- Console ---
        ActionCommand::Console { page, level, filter } => {
            let mut filter_code = String::new();
            if let Some(lvl) = level {
                filter_code += &format!("msgs = msgs.filter(m => m.type === {});\n", js_str(lvl));
            }
            if let Some(f) = filter {
                filter_code += &format!("msgs = msgs.filter(m => m.text.includes({}));\n", js_str(f));
            }
            Some(format!(
                r#"const page = await browser.getPage({p});
// Collect console messages via Playwright's protocol-level hook (catches everything)
const collected = [];
const handler = (msg) => collected.push({{ type: msg.type(), text: msg.text(), url: msg.location().url || "" }});
page.on("console", handler);
// Also listen for page errors (uncaught exceptions)
const errHandler = (err) => collected.push({{ type: "error", text: err.message, url: "" }});
page.on("pageerror", errHandler);
// Wait briefly to catch any queued messages
await page.waitForTimeout(100);
// Also get any messages from recent page activity by triggering a small eval
await page.evaluate(() => {{}});
await page.waitForTimeout(200);
page.off("console", handler);
page.off("pageerror", errHandler);
let msgs = collected;
{filter_code}if (msgs.length === 0) {{
  console.log("(no console messages captured — run console early to start listening)");
}} else {{
  for (const m of msgs) {{
    console.log(m.type.toUpperCase().padEnd(5) + " " + m.text);
  }}
}}"#,
                p = js_str(page),
            ))
        }

        // --- Network subcommands ---
        ActionCommand::Network { action } => Some(match action {
            NetworkCommand::Requests { page, filter, r#type, method: _ } => {
                format!(
                    r#"const page = await browser.getPage({p});
const info = await page.evaluate(() => {{
  return performance.getEntriesByType("resource").map(r => ({{
    name: r.name, type: r.initiatorType, duration: Math.round(r.duration),
    size: r.transferSize || 0, status: r.responseStatus || 0
  }}));
}});
let filtered = info;
{filter_code}
console.log(JSON.stringify(filtered.slice(-50), null, 2));"#,
                    p = js_str(page),
                    filter_code = {
                        let mut code = String::new();
                        if let Some(f) = filter {
                            code += &format!("filtered = filtered.filter(r => r.name.includes({}));\n", js_str(f));
                        }
                        if let Some(t) = r#type {
                            code += &format!("filtered = filtered.filter(r => r.type === {});\n", js_str(t));
                        }
                        code
                    },
                )
            }
            NetworkCommand::Block { pattern, page } => format!(
                "const page = await browser.getPage({p});\nawait page.route({pat}, (route) => route.abort());",
                p = js_str(page),
                pat = js_str(pattern),
            ),
            NetworkCommand::Route { pattern, abort, body, status, page } => {
                if *abort {
                    format!(
                        "const page = await browser.getPage({p});\nawait page.route({pat}, (route) => route.abort());",
                        p = js_str(page), pat = js_str(pattern),
                    )
                } else if let Some(b) = body {
                    format!(
                        r#"const page = await browser.getPage({p});
await page.route({pat}, (route) => route.fulfill({{ status: {status}, contentType: "application/json", body: {body} }}));"#,
                        p = js_str(page), pat = js_str(pattern), body = js_str(b),
                    )
                } else {
                    format!(
                        "const page = await browser.getPage({p});\nawait page.route({pat}, (route) => route.continue());",
                        p = js_str(page), pat = js_str(pattern),
                    )
                }
            }
            NetworkCommand::Unroute { pattern, page } => {
                if let Some(pat) = pattern {
                    format!(
                        "const page = await browser.getPage({p});\nawait page.unroute({pat});",
                        p = js_str(page), pat = js_str(pat),
                    )
                } else {
                    format!(
                        "const page = await browser.getPage({p});\nawait page.unrouteAll();",
                        p = js_str(page),
                    )
                }
            }
        }),
    }
}

/// Helper to generate action scripts that work with either a numeric index or a CSS selector.
fn gen_action_by_target(
    page: &str,
    target: &str,
    _action_name: &str,
    by_index: impl FnOnce(String, String) -> String,
    by_selector: impl FnOnce(String, String) -> String,
) -> String {
    let page_js = js_str(page);
    if let Ok(idx) = target.parse::<u32>() {
        by_index(page_js, idx.to_string())
    } else {
        by_selector(page_js, js_str(target))
    }
}
