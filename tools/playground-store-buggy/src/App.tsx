import { Route, Routes } from "react-router-dom";
import { CartProvider } from "./contexts/CartContext";
import { ToastProvider } from "./contexts/ToastContext";
import { Navbar } from "./components/Navbar";
import { Toasts } from "./components/Toasts";
import { CatalogPage } from "./pages/CatalogPage";
import { ProductDetailPage } from "./pages/ProductDetailPage";
import { CartPage } from "./pages/CartPage";
import { CheckoutPage } from "./pages/CheckoutPage";
import { ConfirmationPage } from "./pages/ConfirmationPage";
import { OrdersPage } from "./pages/OrdersPage";
import { NotFoundPage } from "./pages/NotFoundPage";

export default function App() {
    return (
        <ToastProvider>
            <CartProvider>
                <Navbar />
                <Routes>
                    <Route path="/" element={<CatalogPage />} />
                    <Route path="/product/:slug" element={<ProductDetailPage />} />
                    <Route path="/cart" element={<CartPage />} />
                    <Route path="/checkout" element={<CheckoutPage />} />
                    <Route path="/confirmation/:orderId" element={<ConfirmationPage />} />
                    <Route path="/orders" element={<OrdersPage />} />
                    <Route path="*" element={<NotFoundPage />} />
                </Routes>
                <Toasts />
            </CartProvider>
        </ToastProvider>
    );
}
