import { render } from "../../components/test-utils";

import App from "../app";

describe("App", () => {
    it("should render the app container", () => {
        const { container } = render(<App />);
        expect(container.querySelector(".app-shell")).toBeTruthy();
    });
});
