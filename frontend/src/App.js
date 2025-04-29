import React, { useState, useEffect } from "react";
import { Routes, Route, Link, Navigate, useNavigate, useLocation } from "react-router-dom";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowRight, faCalendar, faArrowRightFromBracket, faArrowUp } from '@fortawesome/free-solid-svg-icons'; // Add faArrowUp for the back-to-top icon
import { faUser } from '@fortawesome/free-regular-svg-icons';
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./App.css";
import inverted_logo from "./images/logo_inverted.png"
import logo from "./images/logo.png";
import Pricing from "./Pricing";
import Contact from "./Contact";
import Scheduler from "./Scheduler";
import Dashboard from "./Dashboard";
import LegalPages from "./LegalPages";
import facebookIcon from "./images/facebook.png";
import linkedinIcon from "./images/linkedin.png";
import instagramIcon from "./images/instagram.png";
import AuthModal from './AuthModal';
import ProfileModal from './profile';
import InterviewDetails from './InterviewDetails';
import axios from 'axios';

function App() {
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [activeIndex, setActiveIndex] = useState(null);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false); // State to control the visibility of the back-to-top button

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.2 } // Trigger when 20% of the element is visible
    );

    const elements = document.querySelectorAll(".scroll-reveal");
    elements.forEach(el => observer.observe(el));

    return () => {
      elements.forEach(el => observer.unobserve(el));
    };
  }, [location.pathname]);

  // Handle scroll to a specific section
  const scrollToSection = (sectionId) => {
    if (location.pathname !== "/") {
      navigate("/"); // Redirect to the home page if not already there
    }

    // Use a timeout to ensure the home page has loaded before scrolling
    setTimeout(() => {
      const section = document.getElementById(sectionId);
      if (section) {
        section.scrollIntoView({ behavior: "smooth" });
      }
    }, 100); // Adjust the timeout if needed
  };

  // Function to toggle FAQ
  const toggleFAQ = (index) => {
    if (activeIndex === index) {
      setActiveIndex(null);
    } else {
      setActiveIndex(index);
    }
  };

  // Function to handle profile click
  const handleProfileClick = () => {
    setIsProfileModalOpen(true);
  };

  // Function to handle logout
  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('email');
    setIsAuthenticated(false);
    setUser(null);
    navigate('/');
  };

  // Function to handle scroll event
  const handleScroll = () => {
    if (window.scrollY > 300) { // Show the button after scrolling 300px
      setShowBackToTop(true);
    } else {
      setShowBackToTop(false);
    }
  };

  // Function to scroll back to the top
  const scrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: "smooth", // Smooth scroll
    });
  };

  // Add scroll event listener on component mount
  useEffect(() => {
    window.addEventListener("scroll", handleScroll);
    return () => {
      window.removeEventListener("scroll", handleScroll); // Cleanup the event listener
    };
  }, []);

  // Rest of your existing code (authentication logic, etc.)
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      setIsAuthenticated(true);
      const userDataString = localStorage.getItem('user');
      if (userDataString) {
        try {
          const userData = JSON.parse(userDataString);
          setUser(userData);
        } catch (error) {
          console.error('Error parsing user data:', error);
          localStorage.removeItem('user');
        }
      }
    }

    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get('token');
    if (tokenFromUrl) {
      localStorage.setItem('token', tokenFromUrl);
      axios.get(`${process.env.REACT_APP_BACKEND_URL}/api/profile`, {
        headers: {
          Authorization: `Bearer ${tokenFromUrl}`,
        },
      })
        .then(response => {
          const userData = response.data.user;
          localStorage.setItem('user', JSON.stringify(userData));
          setIsAuthenticated(true);
          setUser(userData);
          navigate('/');
        })
        .catch(error => {
          console.error('Error fetching user profile:', error);
        });
    }
  }, [navigate]);

  const handleAuthSuccess = (userData) => {
    setIsAuthenticated(true);
    setUser(userData);
    setIsAuthModalOpen(false);
  };

  const ProtectedRoute = ({ children }) => {
    if (!isAuthenticated) {
      return <Navigate to="/" replace />;
    }
    return children;
  };

  return (
    <div className="container-fluid">
      {/* Navbar */}
      <nav className="custom-navbar">
        <div className="navbar-left">
          <Link to="/">
            <img src={logo} alt="Logo" className="navbar-logo" />
          </Link>
        </div>
        <div className="navbar-center">
          <div className="nav-links-container">
            <Link to="/" className="nav-link">Home</Link>
            <Link
              to="/"
              className="nav-link"
              onClick={(e) => {
                e.preventDefault();
                scrollToSection("pricing");
                // document.getElementById("pricing").scrollIntoView({ behavior: "smooth" });
              }}
            >
              Pricing
            </Link>
            <Link
              to="/"
              className="nav-link"
              onClick={(e) => {
                e.preventDefault();
                scrollToSection("contact");
              }}
            >
              Contact Us
            </Link>
            <Link to="/Dashboard" className="nav-link">Dashboard</Link>
            <div className="nav-item dropdown group relative inline-block">
              <span className="nav-link flex items-center gap-1 cursor-pointer">
                Services
                <i className="fa-solid fa-sort-down transform transition-transform duration-300 group-hover:rotate-180"></i>
              </span>
              <div className="dropdown-content absolute hidden group-hover:block opacity-0 group-hover:opacity-100 transition-all duration-300 transform -translate-y-2 group-hover:translate-y-0">
                <Link to="/ai-interviews" className="dropdown-link">AI Interviews</Link>
                <Link to="/ai-customer-service" className="dropdown-link">AI Customer Service</Link>
              </div>
            </div>

          </div>
        </div>
        <div className="navbar-right">
          {isAuthenticated ? (
            <>
              <button className="profile-button" onClick={handleProfileClick}>
                <FontAwesomeIcon icon={faUser} className="user-icon" />
                <span>profile</span>
              </button>
              <button className="logout-button" onClick={handleLogout}>
                <div className="logout-button-content">
                  <FontAwesomeIcon icon={faArrowRightFromBracket} className="logout-icon" />
                  <span>logout</span>
                </div>
              </button>
              {isProfileModalOpen && (
                <ProfileModal onClose={() => setIsProfileModalOpen(false)} />
              )}
            </>
          ) : (
            <button className="signup-button" onClick={() => setIsAuthModalOpen(true)}>
              Login
            </button>
          )}
        </div>
      </nav>

      {/* Auth Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onRequestClose={() => setIsAuthModalOpen(false)}
        // onAuthSuccess={(user) => {console.log("User autheticated:", user);}}
        onAuthSuccess={handleAuthSuccess}
      />

      {/* Routes */}
      <Routes>
        <Route path="/" element={
          <>
            {/* Hero Section */}
            <header className="hero scroll-reveal">
              <h1>The Future of AI-Powered Calls</h1>
              <p>Experience seamless AI-driven phone calls for seamless automation</p>
              <div className="hero-buttons">
                <button
                  className="hero-button get-started"
                  onClick={() => {
                    document.getElementById("pricing").scrollIntoView({ behavior: "smooth" });
                  }}
                >
                  Get Started
                  <span className="icon-arrow">
                    <FontAwesomeIcon icon={faArrowRight} />
                  </span>
                </button>
                <button
                  className="hero-button book-call-button"
                  onClick={(e) => {
                    e.preventDefault(); // Prevent default navigation
                    document.getElementById("contact").scrollIntoView({ behavior: "smooth" }); // Smooth scroll to the contact section
                  }}
                >
                  Book a Demo
                  <span className="icon-calendar">
                    <FontAwesomeIcon icon={faCalendar} />
                  </span>
                </button>
              </div>
            </header>

            {/* Features Section */}
            <section className="features scroll-reveal">
              <h2>Why Choose moon AI?</h2>
              <div className="feature-cards">
                <div className="card">
                  <h3>Efficient Screening</h3>
                  <p>Automate the initial screening process with AI-powered interviews.</p>
                </div>
                <div className="card">
                  <h3>24/7 Availability</h3>
                  <p>Conduct interviews anytime, anywhere with our AI interviewer.</p>
                </div>
                <div className="card">
                  <h3>Data-Driven Insights</h3>
                  <p>Get detailed analytics and insights from each interview.</p>
                </div>
              </div>
            </section>

            <Pricing></Pricing>

            {/* How It Works Section */}
            <section className="how-it-works">
  <h2>How It Works</h2>
  <div className="point point-1 scroll-reveal">
    <div className="point-content">
      <h3>Choose Your Plan</h3>
      <p>
        Select between AI Interview calls or AI Customer Service solutions. Our flexible plans range from pay-as-you-go to unlimited calls, with transparent pricing for all needs.
      </p>
    </div>
    <div className="point-number">01</div>
  </div>
  <div className="point point-2 scroll-reveal">
    <div className="point-number">02</div>
    <div className="point-content">
      <h3>Access Your Dashboard</h3>
      <p>
        After purchasing, you'll land in your dashboard where you can manage all calls, view analytics, and schedule new AI conversations with a single click.
      </p>
    </div>
  </div>
  <div className="point point-3 scroll-reveal">
    <div className="point-content">
      <h3>Schedule the Call</h3>
      <p>
        Click "Schedule Call", choose between Interview or Customer Service mode, pick a time, and provide contact details and call parameters.
      </p>
    </div>
    <div className="point-number">03</div>
  </div>
  <div className="point point-4 scroll-reveal">
    <div className="point-number">04</div>
    <div className="point-content">
      <h3>Recipient Receives Call</h3>
      <p>
        At the scheduled time, our system automatically calls the designated number. No apps needed - they just answer their phone for seamless connection.
      </p>
    </div>
  </div>
  <div className="point point-5 scroll-reveal">
    <div className="point-content">
      <h3>AI Handles the Conversation</h3>
      <p>
        Our AI conducts natural conversations tailored to your needs - whether conducting interviews or providing customer support, with real-time adaptation.
      </p>
    </div>
    <div className="point-number">05</div>
  </div>
  <div className="point point-6 scroll-reveal">
    <div className="point-number">06</div>
    <div className="point-content">
      <h3>Review Results & Insights</h3>
      <p>
        Receive comprehensive reports with conversation analytics, evaluation scores, and actionable insights for both interview and customer service calls.
      </p>
    </div>
  </div>
</section>

            {/* FAQ Section */}
            <section className="faq">
              <h2>Frequently Asked Questions</h2>
              <div className="faq-container">
                <div className={`faq-item ${activeIndex === 0 ? "active" : ""}`}>
                  <button className="faq-question" onClick={() => toggleFAQ(0)}>
                    What is moon AI?
                    <span className="faq-icon">+</span>
                  </button>
                  <div className="faq-answer">
                    <p>
                      moon AI is an AI-powered platform that automates the recruitment process by conducting AI-driven phone interviews.
                    </p>
                  </div>
                </div>
                <div className={`faq-item ${activeIndex === 1 ? "active" : ""}`}>
                  <button className="faq-question" onClick={() => toggleFAQ(1)}>
                    How does moon AI work?
                    <span className="faq-icon">+</span>
                  </button>
                  <div className="faq-answer">
                    <p>
                      moon AI uses advanced natural language processing (NLP) to conduct interviews, evaluate responses, and provide detailed analytics.
                    </p>
                  </div>
                </div>
                <div className={`faq-item ${activeIndex === 2 ? "active" : ""}`}>
                  <button className="faq-question" onClick={() => toggleFAQ(2)}>
                    Is moon AI free to use?
                    <span className="faq-icon">+</span>
                  </button>
                  <div className="faq-answer">
                    <p>
                      moon AI offers a free trial for new users. After the trial, you can choose from our affordable pricing plans.
                    </p>
                  </div>
                </div>
                <div className={`faq-item ${activeIndex === 3 ? "active" : ""}`}>
                  <button className="faq-question" onClick={() => toggleFAQ(3)}>
                    Can I customize the interview questions?
                    <span className="faq-icon">+</span>
                  </button>
                  <div className="faq-answer">
                    <p>
                      Yes, you can customize the interview questions based on the job role and requirements.
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* Contact Section */}
            <Contact />
          </>
        } />
        <Route path="/contact" element={<Navigate to="/" replace />} />
        <Route path="/Dashboard" element={<Dashboard />} />
        <Route path="/Scheduler" element={<Scheduler />} />
        <Route path="/privacyAndTerms" element={<LegalPages />} />
        <Route path="/refund-cancellation-policy" element={<LegalPages />} />
        <Route path="/interview-details" element={<InterviewDetails />} />
      </Routes>

      {/* Back to Top Button */}
      {showBackToTop && (
        <button className="back-to-top" onClick={scrollToTop}>
          <FontAwesomeIcon icon={faArrowUp} />
        </button>
      )}

      {/* Footer */}
      <footer className="footer">
        <div className="footer-content">
          <div className="footer-section about-us">
            <h3>About Us</h3>
            <p>
              moon AI is revolutionizing the hiring process with AI-powered phone interviews.
              Our mission is to make recruitment seamless, efficient, and data-driven.
            </p>
            <img src={inverted_logo} alt="moon AI Logo" className="footer-logo" />
          </div>
          <div className="footer-section">
            <h3>Quick Links</h3>
            <ul>
              <li>
                <Link
                  to="/"
                  onClick={(e) => {
                    e.preventDefault();
                    scrollToSection("contact");
                  }}
                >
                  Contact
                </Link>
              </li>
              <li><Link to="/refund-cancellation-policy">Privacy and terms</Link></li>
              <li><Link to="/refund-cancellation-policy">Refund Policy</Link></li>
            </ul>
          </div>
          <div className="footer-section">
            <div className="footer-section contact-us">
              <h3>Contact Us</h3>
              <ul>
                <li>Email: moon.voice.ai@gmail.com</li>
                <li>Phone: +91 88516 19182</li>
                {/* <li>Adress: Block O, Type V(B), Sector 10, Nivedita Kunj, RK Puram Delhi India, 110022</li> */}
              </ul>
            </div>
          </div>
          <div className="footer-section">
            <h3>Follow Us</h3>
            <div className="social-links">
              <a href="-" target="_blank" rel="noopener noreferrer">
                <img src={facebookIcon} alt="Facebook" />
              </a>
              <a href="https://www.linkedin.com/company/moon-voice-ai/about/?viewAsMember=true" target="_blank" rel="noopener noreferrer">
                <img src={linkedinIcon} alt="LinkedIn" />
              </a>
              <a href="-" target="_blank" rel="noopener noreferrer">
                <img src={instagramIcon} alt="Instagram" />
              </a>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <p>&copy; 2025 moon AI. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}

export default App;