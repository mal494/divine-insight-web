import { getRouter } from "./router";
import "@tanstack/react-start";

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
