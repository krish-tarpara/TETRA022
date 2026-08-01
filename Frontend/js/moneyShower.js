(function() {
    // Load Three.js dynamically
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
    script.onload = init;
    document.head.appendChild(script);

    function init() {
        const scene = new THREE.Scene();

        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        camera.position.z = 100;

        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.domElement.style.position = 'fixed';
        renderer.domElement.style.top = '0';
        renderer.domElement.style.left = '0';
        renderer.domElement.style.zIndex = '1';
        renderer.domElement.style.pointerEvents = 'none';
        document.body.appendChild(renderer.domElement);

        // Create money geometry (rectangle proportion of a dollar bill)
        const geometry = new THREE.PlaneGeometry(4, 1.7);
        
        const symbols = ['$', '€', '£', '¥', '₹', '💵', '💸', '💰', '🪙'];
        const materials = symbols.map(sym => {
            const canvas = document.createElement('canvas');
            canvas.width = 128;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, 128, 64);
            
            ctx.fillStyle = '#166534';
            ctx.font = 'bold 48px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(sym, 64, 32);

            const texture = new THREE.CanvasTexture(canvas);
            return new THREE.MeshBasicMaterial({ 
                map: texture, 
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.8
            });
        });

        const bills = [];
        const numBills = 100; // Number of bills falling

        for (let i = 0; i < numBills; i++) {
            const material = materials[Math.floor(Math.random() * materials.length)];
            const bill = new THREE.Mesh(geometry, material);
            
            // Random start positions
            bill.position.x = (Math.random() - 0.5) * 200;
            bill.position.y = (Math.random() - 0.5) * 200;
            bill.position.z = (Math.random() - 0.5) * 100;
            
            // Random initial rotations
            bill.rotation.x = Math.random() * Math.PI;
            bill.rotation.y = Math.random() * Math.PI;
            bill.rotation.z = Math.random() * Math.PI;
            
            // Random velocities - significantly slower
            bill.userData = {
                velY: - (Math.random() * 0.15 + 0.05), // Slower Falling speed
                velX: (Math.random() - 0.5) * 0.05,    // Slower Drift
                velRotX: (Math.random() - 0.5) * 0.02,
                velRotY: (Math.random() - 0.5) * 0.02,
                velRotZ: (Math.random() - 0.5) * 0.02
            };

            scene.add(bill);
            bills.push(bill);
        }

        const mouse = new THREE.Vector2(-1000, -1000); // Start offscreen
        const raycaster = new THREE.Raycaster();
        const planeZ0 = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        const targetVector = new THREE.Vector3(-1000, -1000, 0);

        window.addEventListener('mousemove', (event) => {
            mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
            mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);
            raycaster.ray.intersectPlane(planeZ0, targetVector);
        });

        function animate() {
            requestAnimationFrame(animate);

            bills.forEach(bill => {
                // Interactive Mouse Repulsion Force
                const dx = bill.position.x - targetVector.x;
                const dy = bill.position.y - targetVector.y;
                const distSq = dx*dx + dy*dy;
                
                if (distSq < 1600) { // 40 radius squared
                    const dist = Math.sqrt(distSq);
                    const force = (40 - dist) / 40;
                    bill.position.x += (dx / dist) * force * 2.5;
                    bill.position.y += (dy / dist) * force * 2.5;
                    // Add chaotic spin when hit by mouse
                    bill.rotation.x += force * 0.2;
                    bill.rotation.z += force * 0.2;
                }

                bill.position.y += bill.userData.velY;
                bill.position.x += bill.userData.velX;
                bill.rotation.x += bill.userData.velRotX;
                bill.rotation.y += bill.userData.velRotY;
                bill.rotation.z += bill.userData.velRotZ;

                // Reset position when bill falls below screen bounds
                if (bill.position.y < -100) {
                    bill.position.y = 100;
                    bill.position.x = (Math.random() - 0.5) * 200;
                }
            });

            renderer.render(scene, camera);
        }

        animate();

        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }
})();
