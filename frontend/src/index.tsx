import { render } from "solid-js/web";
import "./index.css";
import "./stores/theme"; // side-effect: applies stored theme before first render
import { App } from "./App";

render(() => <App />, document.getElementById("root")!);
