import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import * as store from "../api/store";
import type { Cart, Order, Product } from "../types";

interface CartContextValue {
    cart: Cart;
    products: Product[];
    add: (product: Product, quantity?: number) => void;
    setQuantity: (productId: string, quantity: number) => void;
    remove: (productId: string) => void;
    applyCoupon: (code: string) => void;
    clearCoupon: () => void;
    totals: { subtotalCents: number; discountCents: number; totalCents: number };
    itemCount: number;
    placeOrder: (shipping: store.ShippingInput) => Order;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
    const [cart, setCart] = useState<Cart>(() => store.readCart());
    const [products, setProducts] = useState<Product[]>([]);

    // Load the catalog once; the cart rehydrates from localStorage.
    useEffect(() => {
        void store.listProducts().then(setProducts);
    }, []);

    const totals = useMemo(() => store.cartTotals(cart, products), [cart, products]);
    const itemCount = useMemo(
        () => cart.lines.reduce((sum, line) => sum + line.quantity, 0),
        [cart],
    );

    const add = useCallback(
        (product: Product, quantity = 1) => {
            const next = store.addToCart(product, cart, quantity);
            setCart(next);
        },
        [cart],
    );

    const setQuantity = useCallback(
        (productId: string, quantity: number) =>
            setCart(store.setCartQuantity(cart, productId, quantity)),
        [cart],
    );

    const remove = useCallback(
        (productId: string) => setCart(store.removeFromCart(cart, productId)),
        [cart],
    );

    const applyCoupon = useCallback(
        (code: string) => setCart(store.applyCoupon(cart, code)),
        [cart],
    );

    const clearCoupon = useCallback(() => setCart({ ...cart, coupon: null }), [cart]);

    const placeOrder = useCallback(
        (shipping: store.ShippingInput) => {
            const order = store.placeOrder({ cart, shipping });
            setCart({ lines: [], coupon: null });
            return order;
        },
        [cart],
    );

    const value = useMemo<CartContextValue>(
        () => ({
            cart,
            products,
            add,
            setQuantity,
            remove,
            applyCoupon,
            clearCoupon,
            totals,
            itemCount,
            placeOrder,
        }),
        [
            cart,
            products,
            add,
            setQuantity,
            remove,
            applyCoupon,
            clearCoupon,
            totals,
            itemCount,
            placeOrder,
        ],
    );

    return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
    const ctx = useContext(CartContext);
    if (!ctx) throw new Error("useCart must be used inside CartProvider");
    return ctx;
}
