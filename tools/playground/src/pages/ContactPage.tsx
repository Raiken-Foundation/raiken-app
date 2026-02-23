import { useState } from "react";
import { Link } from "react-router-dom";
import { validateEmail } from "../utils";

function ContactPage() {
    const [form, setForm] = useState({
        name: "",
        email: "",
        subject: "",
        message: "",
    });
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [submitted, setSubmitted] = useState(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const newErrors: Record<string, string> = {};

        if (!form.name.trim()) {
            newErrors.name = "Name is required";
        }
        if (!form.email.trim()) {
            newErrors.email = "Email is required";
        } else if (!validateEmail(form.email)) {
            newErrors.email = "Invalid email format";
        }
        if (!form.subject.trim()) {
            newErrors.subject = "Subject is required";
        }
        if (!form.message.trim()) {
            newErrors.message = "Message is required";
        } else if (form.message.trim().length < 10) {
            newErrors.message = "Message must be at least 10 characters";
        }

        if (Object.keys(newErrors).length > 0) {
            setErrors(newErrors);
            return;
        }

        setErrors({});
        setSubmitted(true);
    };

    if (submitted) {
        return (
            <div className="page contact-page" data-testid="contact-page">
                <div className="page-header">
                    <h1>Contact Us</h1>
                </div>
                <div className="card success-card" data-testid="contact-success">
                    <span className="success-icon">✅</span>
                    <h2>Message Sent!</h2>
                    <p>
                        Thank you for reaching out, {form.name}. We'll get back
                        to you at {form.email} shortly.
                    </p>
                    <div className="form-actions">
                        <button
                            onClick={() => {
                                setSubmitted(false);
                                setForm({
                                    name: "",
                                    email: "",
                                    subject: "",
                                    message: "",
                                });
                            }}
                            className="btn btn-primary"
                            data-testid="send-another"
                        >
                            Send Another Message
                        </button>
                        <Link
                            to="/"
                            className="btn btn-secondary"
                            data-testid="back-home"
                        >
                            Back to Home
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="page contact-page" data-testid="contact-page">
            <div className="page-header">
                <h1>Contact Us</h1>
                <p className="page-subtitle">
                    Have a question or feedback? We'd love to hear from you.
                </p>
            </div>

            <div className="contact-layout">
                <div className="contact-info" data-testid="contact-info">
                    <div className="info-card">
                        <span className="info-icon">📧</span>
                        <h3>Email</h3>
                        <p>support@raiken.dev</p>
                    </div>
                    <div className="info-card">
                        <span className="info-icon">💬</span>
                        <h3>Chat</h3>
                        <p>Available Mon-Fri, 9am-5pm</p>
                    </div>
                    <div className="info-card">
                        <span className="info-icon">📍</span>
                        <h3>Location</h3>
                        <p>San Francisco, CA</p>
                    </div>
                </div>

                <form
                    onSubmit={handleSubmit}
                    className="card contact-form"
                    data-testid="contact-form"
                >
                    <h2>Send a Message</h2>

                    <div className="form-row">
                        <div className="form-group">
                            <label htmlFor="contact-name">Name *</label>
                            <input
                                id="contact-name"
                                type="text"
                                value={form.name}
                                onChange={(e) =>
                                    setForm({ ...form, name: e.target.value })
                                }
                                placeholder="Your name"
                                data-testid="contact-name-input"
                            />
                            {errors.name && (
                                <span
                                    className="error"
                                    data-testid="contact-name-error"
                                >
                                    {errors.name}
                                </span>
                            )}
                        </div>

                        <div className="form-group">
                            <label htmlFor="contact-email">Email *</label>
                            <input
                                id="contact-email"
                                type="email"
                                value={form.email}
                                onChange={(e) =>
                                    setForm({ ...form, email: e.target.value })
                                }
                                placeholder="your@email.com"
                                data-testid="contact-email-input"
                            />
                            {errors.email && (
                                <span
                                    className="error"
                                    data-testid="contact-email-error"
                                >
                                    {errors.email}
                                </span>
                            )}
                        </div>
                    </div>

                    <div className="form-group">
                        <label htmlFor="contact-subject">Subject *</label>
                        <select
                            id="contact-subject"
                            value={form.subject}
                            onChange={(e) =>
                                setForm({ ...form, subject: e.target.value })
                            }
                            data-testid="contact-subject-select"
                        >
                            <option value="">Select a topic...</option>
                            <option value="general">General Inquiry</option>
                            <option value="bug">Bug Report</option>
                            <option value="feature">Feature Request</option>
                            <option value="support">Technical Support</option>
                        </select>
                        {errors.subject && (
                            <span
                                className="error"
                                data-testid="contact-subject-error"
                            >
                                {errors.subject}
                            </span>
                        )}
                    </div>

                    <div className="form-group">
                        <label htmlFor="contact-message">Message *</label>
                        <textarea
                            id="contact-message"
                            value={form.message}
                            onChange={(e) =>
                                setForm({ ...form, message: e.target.value })
                            }
                            placeholder="Describe your question or feedback..."
                            rows={6}
                            data-testid="contact-message-input"
                        />
                        {errors.message && (
                            <span
                                className="error"
                                data-testid="contact-message-error"
                            >
                                {errors.message}
                            </span>
                        )}
                    </div>

                    <button
                        type="submit"
                        className="btn btn-primary btn-full"
                        data-testid="contact-submit"
                    >
                        Send Message
                    </button>
                </form>
            </div>
        </div>
    );
}

export default ContactPage;
