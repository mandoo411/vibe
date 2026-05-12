const screenEl = document.getElementById("screen");
const historyEl = document.getElementById("history");

const state = {
  display: "0",
  prev: null,
  op: null,
  waitingForNext: false,
  lastKeyWasEquals: false,
};

function formatNumberString(str) {
  if (str === "Error") return str;
  if (!str) return "0";
  if (str === "-" || str === "-0") return "-0";

  const isNegative = str.startsWith("-");
  const raw = isNegative ? str.slice(1) : str;

  if (raw.includes(".")) {
    const [intPart, decPart] = raw.split(".");
    const intFormatted = intPart ? Number(intPart).toLocaleString("en-US") : "0";
    return `${isNegative ? "-" : ""}${intFormatted}.${decPart}`;
  }

  const num = Number(raw);
  if (!Number.isFinite(num)) return "Error";
  return `${isNegative ? "-" : ""}${num.toLocaleString("en-US")}`;
}

function setDisplay(next) {
  state.display = next;
  screenEl.textContent = formatNumberString(next);
}

function setHistory(text) {
  historyEl.textContent = text || "";
}

function clearAll() {
  state.prev = null;
  state.op = null;
  state.waitingForNext = false;
  state.lastKeyWasEquals = false;
  setHistory("");
  setDisplay("0");
}

function inputDigit(d) {
  if (state.display === "Error") clearAll();

  if (state.waitingForNext || state.lastKeyWasEquals) {
    state.lastKeyWasEquals = false;
    state.waitingForNext = false;
    setDisplay(d);
    return;
  }

  if (state.display === "0") {
    setDisplay(d);
    return;
  }

  if (state.display === "-0") {
    setDisplay(`-${d}`);
    return;
  }

  setDisplay(state.display + d);
}

function inputDecimal() {
  if (state.display === "Error") clearAll();

  if (state.waitingForNext || state.lastKeyWasEquals) {
    state.lastKeyWasEquals = false;
    state.waitingForNext = false;
    setDisplay("0.");
    return;
  }

  if (!state.display.includes(".")) setDisplay(state.display + ".");
}

function backspace() {
  if (state.display === "Error") {
    clearAll();
    return;
  }

  if (state.waitingForNext || state.lastKeyWasEquals) return;

  const next = state.display.slice(0, -1);
  if (next === "" || next === "-") setDisplay("0");
  else setDisplay(next);
}

function toggleSign() {
  if (state.display === "Error") return;
  if (state.waitingForNext) return;

  if (state.display.startsWith("-")) setDisplay(state.display.slice(1));
  else if (state.display !== "0") setDisplay("-" + state.display);
  else setDisplay("-0");
}

function toNumber(str) {
  if (str === "Error") return NaN;
  if (str === "" || str === "-") return 0;
  return Number(str);
}

function compute(a, op, b) {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? NaN : a / b;
    default:
      return b;
  }
}

function commitOperation(nextOp) {
  if (state.display === "Error") return;

  const current = toNumber(state.display);

  if (state.prev == null) {
    state.prev = current;
  } else if (!state.waitingForNext && state.op) {
    const result = compute(state.prev, state.op, current);
    if (!Number.isFinite(result)) {
      setHistory("");
      setDisplay("Error");
      state.prev = null;
      state.op = null;
      state.waitingForNext = true;
      state.lastKeyWasEquals = false;
      return;
    }
    state.prev = result;
    setDisplay(String(result));
  }

  state.op = nextOp;
  state.waitingForNext = true;
  state.lastKeyWasEquals = false;
  setHistory(`${formatNumberString(String(state.prev))} ${symbolForOp(nextOp)}`);
}

function symbolForOp(op) {
  if (op === "/") return "÷";
  if (op === "*") return "×";
  if (op === "-") return "−";
  return op;
}

function equals() {
  if (state.display === "Error") return;
  if (!state.op || state.prev == null) return;

  const current = toNumber(state.display);
  const result = compute(state.prev, state.op, current);

  if (!Number.isFinite(result)) {
    setHistory("");
    setDisplay("Error");
    state.prev = null;
    state.op = null;
    state.waitingForNext = true;
    state.lastKeyWasEquals = false;
    return;
  }

  setHistory(`${formatNumberString(String(state.prev))} ${symbolForOp(state.op)} ${formatNumberString(String(current))} =`);
  setDisplay(String(result));
  state.prev = null;
  state.op = null;
  state.waitingForNext = true;
  state.lastKeyWasEquals = true;
}

function handleButtonClick(btn) {
  const digit = btn.getAttribute("data-digit");
  const op = btn.getAttribute("data-op");
  const action = btn.getAttribute("data-action");

  if (digit != null) return inputDigit(digit);
  if (op != null) return commitOperation(op);

  switch (action) {
    case "clear":
      return clearAll();
    case "backspace":
      return backspace();
    case "toggleSign":
      return toggleSign();
    case "decimal":
      return inputDecimal();
    case "equals":
      return equals();
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest("button[data-digit],button[data-op],button[data-action]") : null;
  if (!btn) return;
  handleButtonClick(btn);
});

document.addEventListener("keydown", (e) => {
  const key = e.key;

  if (key >= "0" && key <= "9") {
    e.preventDefault();
    inputDigit(key);
    return;
  }

  if (key === ".") {
    e.preventDefault();
    inputDecimal();
    return;
  }

  if (key === "Backspace") {
    e.preventDefault();
    backspace();
    return;
  }

  if (key === "Escape") {
    e.preventDefault();
    clearAll();
    return;
  }

  if (key === "Enter" || key === "=") {
    e.preventDefault();
    equals();
    return;
  }

  if (key === "+" || key === "-" || key === "*" || key === "/") {
    e.preventDefault();
    commitOperation(key);
  }
});

clearAll();

