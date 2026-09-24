import type { Cart, CartLine, Order, Product } from "../types";
import { COUPONS, FIXTURE_ANCHOR, PRODUCTS } from "./seed";

/**
 * Storefront state. The catalog is immutable; the cart and orders persist in
 * localStorage so reloads behave like a real store. All reads are async with a
 * fixed latency to exercise the same waiting patterns Orbit does.
 */

const CART_KEY = "bazaar.cart.v1";
const ORDERS_KEY = "bazaar.orders.v1";

const LATENCY_MS = 120;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function readCart(): Cart {
    try {
        const raw = localStorage.getItem(CART_KEY);
        if (!raw) return { lines: [], coupon: null };
        const parsed = JSON.parse(raw) as Cart;
        if (!Array.isArray(parsed.lines)) return { lines: [], coupon: null };
        return parsed;
    } catch {
        return { lines: [], coupon: null };
    }
}

function writeCart(cart: Cart): void {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

export function readOrders(): Order[] {
    try {
        const raw = localStorage.getItem(ORDERS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as Order[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeOrders(orders: Order[]): void {
    localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
}

let orderSeq = 1000;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export async function listProducts(): Promise<Product[]> {
    await sleep(LATENCY_MS);
    return clone(PRODUCTS);
}

export async function getProduct(slug: string): Promise<Product | null> {
    await sleep(LATENCY_MS);
    const product = PRODUCTS.find((p) => p.slug === slug);
    return product ? clone(product) : null;
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

/** Quantity already in the cart plus what is being added — capped by stock. */
export function cartQuantity(productId: string, cart: Cart): number {
    return cart.lines.find((line) => line.productId === productId)?.quantity ?? 0;
}

export function addToCart(product: Product, cart: Cart, quantity: number): Cart {
    const inCart = cartQuantity(product.id, cart);
    const next = inCart + quantity;
    if (next > product.stock) {
        throw new Error(
            `Only ${product.stock} of "${product.name}" left in stock${inCart > 0 ? ` (${inCart} already in your cart)` : ""}.`,
        );
    }
    const lines: CartLine[] = [...cart.lines];
    const existing = lines.find((line) => line.productId === product.id);
    if (existing) existing.quantity = next;
    else lines.push({ productId: product.id, quantity });
    const nextCart: Cart = { ...cart, lines };
    writeCart(nextCart);
    return clone(nextCart);
}

export function setCartQuantity(cart: Cart, productId: string, quantity: number): Cart {
    const product = PRODUCTS.find((p) => p.id === productId);
    if (!product) return cart;
    const clamped = Math.max(0, Math.min(quantity, product.stock));
    const lines =
        clamped === 0
            ? cart.lines.filter((line) => line.productId !== productId)
            : cart.lines.map((line) =>
                  line.productId === productId ? { ...line, quantity: clamped } : line,
              );
    const nextCart: Cart = { ...cart, lines };
    writeCart(nextCart);
    return clone(nextCart);
}

export function removeFromCart(cart: Cart, productId: string): Cart {
    const nextCart: Cart = {
        ...cart,
        lines: cart.lines.filter((line) => line.productId !== productId),
    };
    writeCart(nextCart);
    return clone(nextCart);
}

export function applyCoupon(cart: Cart, code: string): Cart {
    const key = code.trim().toUpperCase();
    const coupon = COUPONS[key];
    if (!coupon) throw new Error(`Coupon "${code.trim()}" is not valid.`);
    const nextCart: Cart = { ...cart, coupon: key };
    writeCart(nextCart);
    return clone(nextCart);
}

export function cartTotals(
    cart: Cart,
    products: Product[],
): { subtotalCents: number; discountCents: number; totalCents: number } {
    const subtotalCents = cart.lines.reduce((sum, line) => {
        const product = products.find((p) => p.id === line.productId);
        return sum + (product?.priceCents ?? 0) * line.quantity;
    }, 0);
    const percentOff = cart.coupon ? (COUPONS[cart.coupon]?.percentOff ?? 0) : 0;
    const discountCents = Math.round((subtotalCents * percentOff) / 100);
    return {
        subtotalCents,
        discountCents,
        totalCents: subtotalCents - discountCents,
    };
}

// ---------------------------------------------------------------------------
// Checkout / orders
// ---------------------------------------------------------------------------

export interface ShippingInput {
    name: string;
    address: string;
    zip: string;
}

export interface PaymentInput {
    cardNumber: string;
    expiry: string;
}

/** Deterministic validation — the same rules the checkout form enforces. */
export function validateShipping(input: ShippingInput): string | null {
    if (!input.name.trim()) return "Name is required.";
    if (!input.address.trim()) return "Address is required.";
    if (!/^\d{5}$/.test(input.zip.trim())) return "ZIP code must be 5 digits.";
    return null;
}

export function validatePayment(input: PaymentInput): string | null {
    const digits = input.cardNumber.replace(/\s+/g, "");
    if (!/^\d{16}$/.test(digits)) return "Card number must be 16 digits.";
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(input.expiry.trim())) {
        return "Expiry must be MM/YY.";
    }
    return null;
}

export function placeOrder(input: { cart: Cart; shipping: ShippingInput }): Order {
    // The catalog is the store's own static source of truth — never take it
    // from caller state, which can race the async load and reject a valid
    // order ("A cart item is no longer available") for a product that exists.
    const productsById = new Map(PRODUCTS.map((p) => [p.id, p]));
    const lines = input.cart.lines.map((line) => {
        const product = productsById.get(line.productId);
        if (!product) throw new Error("A cart item is no longer available.");
        return {
            productId: product.id,
            name: product.name,
            quantity: line.quantity,
            priceCents: product.priceCents,
        };
    });
    if (lines.length === 0) throw new Error("Your cart is empty.");
    const totals = cartTotals(input.cart, PRODUCTS);
    const order: Order = {
        id: `BZ-${orderSeq++}`,
        placedAt: new Date(FIXTURE_ANCHOR).toISOString(),
        lines,
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        totalCents: totals.totalCents,
        shipping: { ...input.shipping },
    };
    writeOrders([order, ...readOrders()]);
    writeCart({ lines: [], coupon: null });
    return clone(order);
}

export { FIXTURE_ANCHOR } from "./seed";
