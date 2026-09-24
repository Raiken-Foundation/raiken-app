import { Route, Routes } from "react-router-dom";
import { Navbar } from "./components/Navbar";
import { Toasts } from "./components/Toasts";
import { CartProvider } from "./contexts/CartContext";
import { ToastProvider } from "./contexts/ToastContext";
import { CartPage } from "./pages/CartPage";
import { CatalogPage } from "./pages/CatalogPage";
import { CheckoutPage } from "./pages/CheckoutPage";
import { ConfirmationPage } from "./pages/ConfirmationPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OrdersPage } from "./pages/OrdersPage";
import { ProductDetailPage } from "./pages/ProductDetailPage";

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
