/**
 * TOC Scroll Tracker
 * Tracks scroll position and highlights active TOC links
 */
class TocScrollTracker {
  constructor() {
    this.tocLinks = document.querySelectorAll('.sidebar-toc a[data-id]');
    this.headings = [];
    this.currentActive = null;

    if (this.tocLinks.length === 0) return;

    this.init();
  }

  init() {
    // Collect all heading elements that have IDs matching TOC links
    this.tocLinks.forEach(link => {
      const id = link.getAttribute('data-id');
      const heading = document.getElementById(id);
      if (heading) {
        this.headings.push({ element: heading, link: link });
      }
    });

    if (this.headings.length === 0) return;

    // Set up Intersection Observer
    this.setupObserver();

    // Handle smooth scroll on TOC link click
    this.setupSmoothScroll();
  }

  setupObserver() {
    const options = {
      rootMargin: '-80px 0px -80% 0px',
      threshold: 0
    };

    this.observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const heading = this.headings.find(h => h.element === entry.target);
          if (heading) {
            this.setActiveLink(heading.link);
          }
        }
      });
    }, options);

    // Observe all headings
    this.headings.forEach(({ element }) => {
      this.observer.observe(element);
    });
  }

  setActiveLink(link) {
    if (this.currentActive === link) return;

    // Remove previous active
    if (this.currentActive) {
      this.currentActive.classList.remove('active');
    }

    // Set new active
    link.classList.add('active');
    this.currentActive = link;

    // Scroll TOC to keep active item visible
    this.scrollTocToActive(link);
  }

  scrollTocToActive(link) {
    const toc = document.querySelector('.sidebar-toc');
    if (!toc) return;

    const linkRect = link.getBoundingClientRect();
    const tocRect = toc.getBoundingClientRect();

    // If link is outside visible TOC area, scroll it into view
    if (linkRect.top < tocRect.top || linkRect.bottom > tocRect.bottom) {
      link.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      });
    }
  }

  setupSmoothScroll() {
    this.tocLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const id = link.getAttribute('data-id');
        const target = document.getElementById(id);

        if (target) {
          const offset = 80; // Account for sticky nav
          const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - offset;

          window.scrollTo({
            top: targetPosition,
            behavior: 'smooth'
          });

          // Update URL hash without jumping
          history.pushState(null, null, `#${id}`);
        }
      });
    });
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new TocScrollTracker());
} else {
  new TocScrollTracker();
}
