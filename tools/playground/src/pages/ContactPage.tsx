import { useId, useState } from "react";
import { useToast } from "../contexts/ToastContext";
import type { ContactMessage } from "../types";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ContactPage() {
    const { push } = useToast();
    const [form, setForm] = useState<ContactMessage>({
        name: "",
        email: "",
        subject: "",
        message: "",
    });
    const [errors, setErrors] = useState<Partial<Record<keyof ContactMessage, string>>>({});
    const [submitted, setSubmitted] = useState(false);
    const nameId = useId();
    const emailId = useId();
    const subjectId = useId();
    const messageId = useId();

    const update = <K extends keyof ContactMessage>(key: K, value: ContactMessage[K]) => {
        setForm((prev) => ({ ...prev, [key]: value }));
    };

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        const next: typeof errors = {};
        if (form.name.trim().length < 2) next.name = "Name is required";
        if (!EMAIL.test(form.email)) next.email = "Enter a valid email";
        if (form.subject.trim().length < 3) next.subject = "Subject is required";
        if (form.message.trim().length < 10)
            next.message = "Message must be at least 10 characters";
        setErrors(next);
        if (Object.keys(next).length === 0) {
            setSubmitted(true);
            push("success", "Message sent");
            setForm({ name: "", email: "", subject: "", message: "" });
        }
    };

    return (
        <div className="page" data-testid="contact-page">
            <header className="page-header">
                <div>
                    <h1>Contact</h1>
                    <p className="page-subtitle">
                        Drop us a note. (Nothing is actually sent — this is a playground.)
                    </p>
                </div>
            </header>

            {submitted && (
                <output className="alert alert-success" data-testid="contact-success">
                    Thanks! We'll be in touch shortly.
                </output>
            )}

            <form className="card contact-form" onSubmit={submit} noValidate>
                <div className="form-row">
                    <div className="form-group">
                        <label htmlFor={nameId}>Name</label>
                        <input
                            id={nameId}
                            value={form.name}
                            onChange={(e) => update("name", e.target.value)}
                            data-testid="contact-name"
                        />
                        {errors.name && (
                            <span className="form-error" data-testid="contact-name-error">
                                {errors.name}
                            </span>
                        )}
                    </div>
                    <div className="form-group">
                        <label htmlFor={emailId}>Email</label>
                        <input
                            id={emailId}
                            type="email"
                            value={form.email}
                            onChange={(e) => update("email", e.target.value)}
                            data-testid="contact-email"
                        />
                        {errors.email && (
                            <span className="form-error" data-testid="contact-email-error">
                                {errors.email}
                            </span>
                        )}
                    </div>
                </div>
                <div className="form-group">
                    <label htmlFor={subjectId}>Subject</label>
                    <input
                        id={subjectId}
                        value={form.subject}
                        onChange={(e) => update("subject", e.target.value)}
                        data-testid="contact-subject"
                    />
                    {errors.subject && (
                        <span className="form-error" data-testid="contact-subject-error">
                            {errors.subject}
                        </span>
                    )}
                </div>
                <div className="form-group">
                    <label htmlFor={messageId}>Message</label>
                    <textarea
                        id={messageId}
                        rows={5}
                        value={form.message}
                        onChange={(e) => update("message", e.target.value)}
                        data-testid="contact-message"
                    />
                    {errors.message && (
                        <span className="form-error" data-testid="contact-message-error">
                            {errors.message}
                        </span>
                    )}
                </div>
                <button type="submit" className="btn btn-primary" data-testid="contact-submit">
                    Send message
                </button>
            </form>
        </div>
    );
}
