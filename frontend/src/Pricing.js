import React, { useState, useEffect } from "react";
import "./Pricing.css";
import AuthModal from "./AuthModal";
import axios from "axios";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTimes, faCheck } from '@fortawesome/free-solid-svg-icons';

const Pricing = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(1);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [planDetailsModal, setPlanDetailsModal] = useState({
    isOpen: false,
    plan: null
  });

  const cards = [
    {
      title: "Basic Plan",
      price: "₹1/month",
      features: ["2 AI Interviews"],
      plan: "Basic Plan",
      amount: 1,
    },
    {
      title: "Pro Plan",
      price: "₹4999/month",
      features: ["250 AI Interviews"],
      plan: "Pro Plan",
      amount: 4999,
    },
    {
      title: "Quantum Flex Plan",
      price: "Pay as you go",
      features: ["Unlimited AI Interviews"],
      plan: "Quantum Flex Plan",
      amount: 10000,
    },
  ];

  const planDetails = {
    "Basic Plan": {
      description: "Perfect for small businesses and startups testing AI interviews and giving mock interviews",
      features: [
        "100 AI interviews per month",
        "Basic candidate evaluation metrics",
        "Email support (48-hour response)",
        "Interview scheduling dashboard",
        "Candidate response recording"
      ],
      bestFor: [
        "Testing AI interviews",
        "Hiring for 1-2 positions/month",
        "Startups with minimal hiring needs"
      ]
    },
    "Pro Plan": {
      description: "For growing businesses with regular hiring needs",
      features: [
        "250 AI interviews per month",
        "Advanced analytics dashboard",
        "Customizable interview questions",
        "Candidate scoring system",
        "Priority email support (24-hour response)",
        "Basic phone support (business hours)"
      ],
      bestFor: [
        "Growing startups",
        "SMEs with regular hiring",
        "Tech companies hiring at scale"
      ]
    },
    "Quantum Flex Plan": {
      description: "Enterprise solution for unlimited hiring needs",
      features: [
        "Unlimited AI interviews",
        "Dedicated account manager",
        "24/7 priority support",
        "Advanced interview customization",
        "Team collaboration tools",
        "API access available",
        "White-label options"
      ],
      bestFor: [
        "Large enterprises",
        "High-volume recruitment",
        "Seasonal hiring spikes",
        "Custom solution needs"
      ]
    }
  };

  useEffect(() => {
    const token = localStorage.getItem("token");
    setIsAuthenticated(!!token);
  }, []);

  const handleBuyNow = async (planName, price) => {
    setError("");
    setSuccessMessage("");

    if (!isAuthenticated) {
      setIsAuthModalOpen(true);
      return;
    }

    try {
      const userEmail = JSON.parse(localStorage.getItem("user"))?.email;
      if (!userEmail) throw new Error("User email not found");

      const response = await axios.post(`${process.env.REACT_APP_BACKEND_URL}/api/create-order`, {
        plan: planName,
        amount: price,
      });

      const { orderId, amount } = response.data;

      if (!window.Razorpay) {
        throw new Error("Razorpay SDK not loaded");
      }

      const options = {
        key: "rzp_live_5tZKVd334qj8oG",
        amount: amount * 100,
        currency: "INR",
        name: "moon AI",
        description: `Payment for ${planName}`,
        order_id: orderId,
        handler: async function (response) {
          try {
            const verification = await axios.post(
              `${process.env.REACT_APP_BACKEND_URL}/verify-payment`,
              {
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_signature: response.razorpay_signature,
                plan: planName,
                email: userEmail
              }
            );

            if (verification.data.success) {
              setSuccessMessage(`Payment Successful! ${planName} activated.`);
              const planData = await axios.get(
                `${process.env.REACT_APP_BACKEND_URL}/user-plan`,
                { params: { email: userEmail } }
              );
              localStorage.setItem('userPlan', JSON.stringify(planData.data));
            } else {
              setError("Payment verification failed. Contact support.");
            }
          } catch (err) {
            console.error("Verification error:", err);
            setError("Payment succeeded but verification failed. Contact support.");
          }
        },
        prefill: { email: userEmail },
        theme: { color: "#3399cc" },
      };

      const razorpay = new window.Razorpay(options);
      razorpay.open();
    } catch (error) {
      console.error("Payment error:", error);
      setError(error.response?.data?.error || error.message || "Payment failed. Please try again.");
    }
  };

  const handleCardClick = (index) => {
    setActiveIndex(index);
  };

  const openPlanDetails = (planName) => {
    setPlanDetailsModal({
      isOpen: true,
      plan: planName
    });
  };

  const closePlanDetails = () => {
    setPlanDetailsModal({
      isOpen: false,
      plan: null
    });
  };

  return (
    <section id="pricing" className="pricing scroll-reveal">
      <div className="pricing">
        <h1>Pricing</h1>
        <div className="pricing-cards">
          {cards.map((card, index) => {
            let position = index - activeIndex;
            if (position < -1) position += 3;
            if (position > 1) position -= 3;

            return (
              <div
                key={index}
                className={`card ${activeIndex === index ? "active" : ""}`}
                onClick={() => handleCardClick(index)}
                style={{
                  transform: `translateX(${position * 80}%) scale(${activeIndex === index ? 1 : 0.85})`,
                  zIndex: activeIndex === index ? 3 : 1,
                  opacity: activeIndex === index ? 1 : 0.6,
                }}
              >
                <h2>{card.title}</h2>
                <p>{card.price}</p>
                <ul>
                  {card.features.map((feature, i) => (
                    <li key={i}>{feature}</li>
                  ))}
                </ul>
                
                {/* Know More Button (now above Buy Now) */}
                <button 
                  className="know-more-button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openPlanDetails(card.plan);
                  }}
                >
                  Know More
                </button>
                
                {/* Buy Now Button */}
                <button 
                  className="pricing-button" 
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBuyNow(card.plan, card.amount);
                  }}
                >
                  Buy Now
                </button>

                {successMessage && activeIndex === index && (
                  <p className="success-message">{successMessage}</p>
                )}
                {error && activeIndex === index && (
                  <p className="error-message">{error}</p>
                )}
              </div>
            );
          })}
        </div>

        {/* Plan Details Modal */}
        {planDetailsModal.isOpen && (
          <div className="plan-details-modal"
          onClick={closePlanDetails}>
            <div className="modal-content"
            onClick={(e) => e.stopPropagation()}>
              <button className="close-modal" onClick={closePlanDetails}>
                <FontAwesomeIcon icon={faTimes} />
              </button>
              
              <h2>{planDetailsModal.plan}</h2>
              <p className="plan-description">{planDetails[planDetailsModal.plan]?.description}</p>
              
              <div className="plan-section">
                <h3>Key Features</h3>
                <ul>
                  {planDetails[planDetailsModal.plan]?.features.map((feature, i) => (
                    <li key={`feature-${i}`}>
                      <FontAwesomeIcon icon={faCheck} className="feature-icon" />
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>              
              <div className="plan-section">
                <h3>Best For</h3>
                <ul>
                  {planDetails[planDetailsModal.plan]?.bestFor.map((useCase, i) => (
                    <li key={`usecase-${i}`}>{useCase}</li>
                  ))}
                </ul>
              </div>
              
              <button 
                className="modal-buy-button"
                onClick={() => {
                  closePlanDetails();
                  handleBuyNow(planDetailsModal.plan, cards.find(c => c.plan === planDetailsModal.plan)?.amount || 0);
                }}
              >
                Get {planDetailsModal.plan}
              </button>
            </div>
          </div>
        )}

        {/* Authentication Modal */}
        <AuthModal
          isOpen={isAuthModalOpen}
          onRequestClose={() => setIsAuthModalOpen(false)}
        />
      </div>
    </section>
  );
};

export default Pricing;