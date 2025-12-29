// Enhanced footnote navigation with back-references
(function() {
    // Add smooth scrolling to all footnote links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const href = this.getAttribute('href');
            if (href.startsWith('#fn')) {
                e.preventDefault();
                const target = document.querySelector(href);
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        });
    });

    // Add back-reference links to footnote definitions
    document.querySelectorAll('.footnote-definition').forEach(footnote => {
        const id = footnote.getAttribute('id');
        if (id) {
            // Find the corresponding footnote reference
            const refId = id.replace('fn', 'fnref');
            const reference = document.querySelector(`a[href="#${id}"]`);

            if (reference) {
                // Create back-reference link
                const backlink = document.createElement('a');
                backlink.href = `#${refId}`;
                backlink.className = 'footnote-backref';
                backlink.textContent = '↩';
                backlink.title = 'Return to text';
                backlink.setAttribute('aria-label', 'Back to content');

                // Add smooth scroll behavior
                backlink.addEventListener('click', function(e) {
                    e.preventDefault();
                    reference.scrollIntoView({ behavior: 'smooth', block: 'center' });

                    // Briefly highlight the reference
                    reference.style.backgroundColor = 'var(--accent)';
                    reference.style.color = 'white';
                    setTimeout(() => {
                        reference.style.backgroundColor = '';
                        reference.style.color = '';
                    }, 1000);
                });

                // Append backlink to the footnote
                footnote.appendChild(document.createTextNode(' '));
                footnote.appendChild(backlink);
            }
        }
    });

    // Add IDs to footnote references if they don't exist
    document.querySelectorAll('sup.footnote-reference a').forEach((ref, index) => {
        const href = ref.getAttribute('href');
        if (href && href.startsWith('#fn')) {
            const fnId = href.substring(1);
            const refId = fnId.replace('fn', 'fnref');
            const sup = ref.closest('sup');
            if (sup && !sup.id) {
                sup.id = refId;
            }
        }
    });
})();
