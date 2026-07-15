import { render } from "../../components/test-utils";

import App from "../app";

describe("App", () => {
    it("should render successfully", () => {
        const { baseElement } = render(<App />);
        expect(baseElement).toBeTruthy();
    });

    it("should render the app container", () => {
        const { container } = render(<App />);
        expect(container.querySelector(".app-shell")).toBeTruthy();
    });
});
